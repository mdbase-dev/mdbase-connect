use std::collections::BTreeMap;
use std::fs::{self, DirBuilder};
use std::io::{self, IsTerminal, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mdbn_local_host::{
    CONFIG_FILE, DescriptorState, HostKind, HostLock, host_lock::descriptor_state,
    store::DEFAULT_PRIVATE_DIR,
};
use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::{Action, Args, Credentials, parse_origin, private_ip, run_with, shared_range};
use crate::fsutil::verify_owner_only;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PORT: u16 = 14918;

fn prompt(question: &str) -> io::Result<String> {
    print!("{question} ");
    io::stdout().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "terminal closed",
        ));
    }
    Ok(line.trim().to_owned())
}

fn confirm(question: &str) -> io::Result<bool> {
    loop {
        match prompt(question)?.to_ascii_lowercase().as_str() {
            "y" | "yes" => return Ok(true),
            "" | "n" | "no" => return Ok(false),
            _ => println!("Enter yes or no (Enter means no)."),
        }
    }
}

// A read-only setup check. open_folder still takes the authoritative lock after consent.
fn check_folder(folder: &Path) -> Result<PathBuf> {
    let root = folder
        .canonicalize()
        .map_err(|e| format!("cannot find collection folder {folder:?}: {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "{root:?} is not a folder. Choose the folder containing {CONFIG_FILE}."
        )
        .into());
    }
    let private = DEFAULT_PRIVATE_DIR;
    match fs::symlink_metadata(root.join(private)) {
        Ok(meta) if !meta.is_dir() => {
            return Err(format!("The collection's {private} must be a real directory.").into());
        }
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
        _ => (),
    }
    let held = HostLock::is_held(&root, private)
        .map_err(|e| format!("Cannot check the collection host lock: {e}"))?;
    match descriptor_state(&root, private) {
        DescriptorState::Unreadable(_) => return Err("Cannot verify this folder's host descriptor. Check its hosting app before retrying.".into()),
        DescriptorState::Present(d) if held || d.host != HostKind::Library => {
            let host = match d.host {
                HostKind::Daemon => "the mdbase daemon",
                HostKind::Obsidian => "Obsidian",
                _ => "another mdbase host",
            };
            return Err(format!("This folder is already hosted by {host}. Close the collection there before pairing.").into());
        }
        _ if held => return Err("Another process holds this collection's host lock. Close the collection there before pairing.".into()),
        _ => (),
    }
    if !root.join(CONFIG_FILE).is_file() {
        return Err(format!("No {CONFIG_FILE} in {root:?}. Choose an initialized collection, or create one in your collection app first.").into());
    }
    Ok(root)
}

fn choose_sites(saved: Option<&Credentials>) -> Result<Option<Vec<String>>> {
    let mut sites = match saved {
        Some(store) => store.origins()?,
        None => Vec::new(),
    };
    println!(
        "Open the app publisher's direct-connection page in your browser. Copy https:// and the hostname (including any port) from the address bar. Leave off the path, query and fragment."
    );
    loop {
        println!("Trusted HTTPS app sites:");
        if sites.is_empty() {
            println!("  None selected.");
        }
        for (index, site) in sites.iter().enumerate() {
            println!("  {}. {site}", index + 1);
        }
        let action = prompt(if sites.is_empty() {
            "Sites: [Enter] add an HTTPS site or [q]uit?"
        } else {
            "Sites: [a]dd, [r]emove, [Enter] continue, or [q]uit?"
        })?;
        match action.to_ascii_lowercase().as_str() {
            "" | "continue" if !sites.is_empty() => return Ok(Some(sites)),
            "q" | "quit" => return Ok(None),
            "r" | "remove" if !sites.is_empty() => {
                let Some(site) = choose(&sites, "Site number to remove (Enter cancels):", None)?
                else {
                    continue;
                };
                if confirm(&format!(
                    "Remove {site} now and revoke ALL its browsers and its code? [y/N]"
                ))? {
                    if let Some(store) = saved {
                        store.remove_site(site)?;
                    }
                    println!("Removed {site}.");
                    let site = site.clone();
                    sites.retain(|candidate| candidate != &site);
                }
            }
            "a" | "add" | "" => loop {
                let input = prompt("App's exact HTTPS origin (Enter cancels):")?;
                if input.is_empty() {
                    break;
                }
                let Ok(site) = parse_origin(input.strip_suffix('/').unwrap_or(&input)) else {
                    println!(
                        "Use one exact HTTPS origin: https:// followed by the hostname and any non-default port. Omit paths, wildcards, and sign-in or invitation details."
                    );
                    continue;
                };
                if sites.contains(&site) {
                    println!("{site} is already selected.");
                    break;
                }
                if confirm(&format!(
                    "Trust {site} to read and write this collection through a paired browser? [y/N]"
                ))? {
                    sites.push(site);
                }
                break;
            },
            _ => println!("Choose add, remove, continue or quit. Serving needs at least one site."),
        }
    }
}

fn verify_state_parent(parent: &Path) -> Result<()> {
    verify_owner_only(parent)?;
    let meta = fs::symlink_metadata(parent)?;
    if !meta.is_dir() || meta.permissions().mode() & 0o7777 != 0o700 {
        return Err("pairing state parent must be a private directory (0700)".into());
    }
    Ok(())
}

fn auth_dir(base: &Path, collection: &Path) -> Result<PathBuf> {
    let base = base.canonicalize()?;
    verify_owner_only(&base)?;
    let parent = base.join(".mdbase-pairing");
    if parent.starts_with(collection) {
        return Err(
            "pairing state must be outside the collection; choose a separate --state-dir".into(),
        );
    }
    match fs::symlink_metadata(&parent) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
        Ok(_) => verify_state_parent(&parent)?,
    }
    let digest = Sha256::digest(collection.as_os_str().as_bytes());
    Ok(parent.join(format!("{digest:x}")))
}

fn choose_network() -> Result<SocketAddr> {
    let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut addresses = BTreeMap::new();
    for iface in if_addrs::get_if_addrs()? {
        let ip = iface.ip();
        if iface.is_oper_up() && ip.is_ipv4() && !ip.is_loopback() && private_ip(ip) {
            addresses.entry(ip).or_insert(iface.name);
        }
    }
    println!("Where will the browser run?\n  1. This computer only (default)");
    let mut options = vec![local];
    for (ip, name) in addresses {
        options.push(ip);
        if shared_range(ip) {
            // Carrier-grade NAT shares this range with overlay VPNs such as Tailscale.
            println!(
                "  {}. VPN {name:?} ({ip}). Choose this only if it is your own VPN, not your internet provider's address.",
                options.len()
            );
        } else {
            println!("  {}. Private network {name:?} ({ip})", options.len());
        }
    }
    if options.len() == 1 {
        println!(
            "Only this computer is available. For another device, connect the host to a private IPv4 network and restart setup."
        );
    } else {
        println!(
            "For another device, match the address to this computer’s Wi-Fi, Ethernet or VPN address on the network both devices use. Skip container and VM bridges unless the browser runs there. Keep router port forwarding off."
        );
    }
    let ip = choose(&options, "Network [1]:", Some(0))?.expect("loopback default is present");
    Ok(SocketAddr::new(*ip, PORT))
}

fn select<'a, T>(choices: &'a [T], answer: &str, default: Option<usize>) -> Result<&'a T> {
    let index = if answer.is_empty() {
        default
    } else {
        answer
            .parse::<usize>()
            .ok()
            .and_then(|number| number.checked_sub(1))
    };
    index
        .and_then(|index| choices.get(index))
        .ok_or_else(|| "select a number from the list".into())
}

fn choose<'a, T>(
    choices: &'a [T],
    question: &str,
    default: Option<usize>,
) -> Result<Option<&'a T>> {
    loop {
        let answer = prompt(question)?;
        if default.is_none() && answer.is_empty() {
            return Ok(None);
        }
        match select(choices, &answer, default) {
            Ok(choice) => return Ok(Some(choice)),
            Err(error) => println!("{error} (1–{}).", choices.len()),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
pub(in crate::cli) async fn start(folder: PathBuf, state_dir: Option<&Path>) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(
            "pair-app needs an interactive terminal; for unattended serving use mdbase self-host"
                .into(),
        );
    }
    let root = check_folder(&folder)?;
    let base = state_dir
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os(crate::paths::ENV_HOME).map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("set HOME or choose an existing private --state-dir")?;
    let auth_dir = auth_dir(&base, &root)?;
    let saved = if auth_dir.join("credentials.sqlite").try_exists()? {
        Some(Credentials::open(&auth_dir, &root, None)?)
    } else {
        None
    };
    println!(
        "Pair an app with {root:?}. Paired browsers can read and write this collection while this command is running."
    );
    let Some(origins) = choose_sites(saved.as_ref())? else {
        println!("Setup closed.");
        return Ok(());
    };
    drop(saved);
    let address = choose_network()?;
    println!(
        "Serve {root:?} to paired browsers from {} at {address}?",
        origins.join(", ")
    );
    if !confirm("Start serving? [y/N]")? {
        println!("Serving cancelled.");
        return Ok(());
    }
    let parent = auth_dir.parent().ok_or("missing state parent")?;
    match DirBuilder::new().mode(0o700).create(parent) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        result => result?,
    }
    verify_state_parent(parent)?;
    run_with(
        Args {
            collection: root,
            origins,
            auth_dir,
            action: Action::Serve {
                listen: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                webtransport: Some(address),
            },
        },
        true,
    )
    .await
}

fn invitation(origin: &str, endpoint: &str, pin: &str) -> String {
    let fragment = form_urlencoded::Serializer::new(String::new())
        .append_pair("mdbase-pair", &format!("{endpoint}#sha256={pin}"))
        .finish();
    format!("{origin}/#{fragment}")
}

pub(super) fn show_invitations(origins: &[String], endpoint: &str, pin: &str) {
    for origin in origins {
        println!("App invitation: {}", invitation(origin, endpoint, pin));
    }
}

pub(super) fn ready(
    credentials: &Arc<Credentials>,
    origins: &[String],
    address: SocketAddr,
    pin: watch::Receiver<Option<String>>,
    menu_done: tokio::sync::oneshot::Sender<()>,
) {
    let origins = origins.to_vec();
    let credentials = Arc::clone(credentials);
    std::thread::spawn(move || {
        println!("Serving at {address}. Leave this terminal open. Press Ctrl-C to stop.");
        loop {
            match menu(&credentials, &origins, address, &pin) {
                Ok(()) => (),
                Err(error) if error.downcast_ref::<io::Error>().is_some() => {
                    eprintln!("Pairing menu closed: {error}. Stopping the server.");
                    let _ = menu_done.send(());
                    return;
                }
                Err(error) => eprintln!("{error}"),
            }
        }
    });
}

fn menu(
    credentials: &Credentials,
    origins: &[String],
    address: SocketAddr,
    pin: &watch::Receiver<Option<String>>,
) -> Result<()> {
    let action = prompt("Browser access: [p]air, [l]ist, or [r]evoke?")?.to_ascii_lowercase();
    if !matches!(
        action.as_str(),
        "p" | "pair" | "l" | "list" | "r" | "revoke"
    ) {
        return Err("Choose pair, list or revoke (p/l/r).".into());
    }
    let origin = if let [one] = origins {
        one
    } else {
        for (index, site) in origins.iter().enumerate() {
            println!("  {}. {site}", index + 1);
        }
        let Some(site) = choose(origins, "App number (Enter cancels):", None)? else {
            return Ok(());
        };
        site
    };
    if matches!(action.as_str(), "p" | "pair") {
        println!(
            "Authorize one browser at {origin} for collection read/write. A new code replaces any previous code for this site."
        );
        let (link, code) = loop {
            let label = prompt("New browser label (for example, My phone; Enter cancels):")?;
            if label.is_empty() {
                return Ok(());
            }
            let link = invitation(
                origin,
                &format!("https://{address}"),
                pin.borrow().as_deref().ok_or(
                    "No verified certificate available. Check the host clock and pairing state.",
                )?,
            );
            match credentials.pair(origin, &label) {
                Ok(code) => break (link, code),
                Err(e)
                    if e.downcast_ref::<io::Error>().is_some_and(|e| {
                        matches!(
                            e.kind(),
                            io::ErrorKind::InvalidInput | io::ErrorKind::AlreadyExists
                        )
                    }) =>
                {
                    println!("{e}")
                }
                Err(e) => return Err(e),
            }
        };
        if address.ip().is_loopback() {
            println!("Open this link in a browser on THIS computer:\n{link}");
        } else {
            println!("On the device using the selected private network, open this link:\n{link}");
            if let Ok(qr) = QrCode::new(link.as_bytes()) {
                println!("\x1b[30;47m{}\x1b[0m", qr.render::<Dense1x2>().build());
            }
        }
        println!("Enter this one-time code in that app: {code} (expires in three minutes).");
    } else {
        if let Some(status) = credentials.window_status(origin)? {
            println!("{status}");
        }
        let entries = credentials.list(origin)?;
        if entries.is_empty() {
            println!("No paired browsers for {origin}.");
        } else {
            for (index, (id, label)) in entries.iter().enumerate() {
                println!("  {}. {label} ({id})", index + 1);
            }
            if matches!(action.as_str(), "r" | "revoke")
                && let Some((id, label)) =
                    choose(&entries, "Browser number to revoke (Enter cancels):", None)?
                && confirm(&format!(
                    "Revoke {label:?} at {origin}, including its open sessions? [y/N]"
                ))?
            {
                credentials.revoke(origin, id)?;
                println!("Revoked {label:?} at {origin}.");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guided_state_is_private_separate_and_does_not_follow_a_symlink() {
        let home = crate::testutil::TestDir::new("pair-app-home");
        let home = home.path().canonicalize().unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let folder = home.join("notes");
        fs::create_dir(&folder).unwrap();
        let scope = auth_dir(&home, &folder).unwrap();
        assert!(!scope.starts_with(&folder));
        assert_eq!(scope, auth_dir(&home, &folder).unwrap());
        assert_ne!(scope, auth_dir(&home, &home.join("other")).unwrap());
        let parent = scope.parent().unwrap();
        assert!(!parent.exists());
        assert!(auth_dir(&home, &home).is_err());
        std::os::unix::fs::symlink(&folder, parent).unwrap();
        assert!(auth_dir(&home, &folder).is_err());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
    }

    #[test]
    fn invitation_keeps_backend_and_pin_entirely_in_fragment() {
        let site = "https://third-party.example";
        let backend = "https://127.0.0.1:14918";
        let pin = "a".repeat(64);
        let mut link = reqwest::Url::parse(&invitation(site, backend, &pin)).unwrap();
        let fragment =
            form_urlencoded::parse(link.fragment().unwrap().as_bytes()).collect::<Vec<_>>();
        assert_eq!(fragment.len(), 1);
        assert_eq!(fragment[0].0, "mdbase-pair");
        assert_eq!(fragment[0].1, format!("{backend}#sha256={pin}"));
        link.set_fragment(None);
        assert_eq!(link.as_str(), format!("{site}/"));
    }

    #[test]
    fn only_an_empty_network_choice_selects_loopback_by_default() {
        let choices = ["loopback", "private"];
        assert_eq!(*select(&choices, "", Some(0)).unwrap(), "loopback");
        assert_eq!(*select(&choices, "2", Some(0)).unwrap(), "private");
        for invalid in ["0", "3", "LAN", "-1"] {
            assert!(select(&choices, invalid, Some(0)).is_err());
        }
        assert!(select(&choices, "", None).is_err());
    }
}
