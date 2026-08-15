use std::fs;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostedProcessMemory {
    pub rss_bytes: Option<u64>,
    pub pss_bytes: Option<u64>,
    pub cgroup_current_bytes: Option<u64>,
    pub cgroup_peak_bytes: Option<u64>,
}

impl HostedProcessMemory {
    pub fn capture() -> Self {
        let smaps = fs::read_to_string("/proc/self/smaps_rollup").ok();
        Self {
            rss_bytes: smaps.as_deref().and_then(|value| proc_kib(value, "Rss:")),
            pss_bytes: smaps.as_deref().and_then(|value| proc_kib(value, "Pss:")),
            cgroup_current_bytes: read_integer("/sys/fs/cgroup/memory.current"),
            cgroup_peak_bytes: read_integer("/sys/fs/cgroup/memory.peak"),
        }
    }
}

fn proc_kib(contents: &str, key: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? != key {
            return None;
        }
        fields.next()?.parse::<u64>().ok()?.checked_mul(1024)
    })
}

fn read_integer(path: &str) -> Option<u64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_memory_without_exporting_process_content() {
        let sample = "Rss:                1234 kB\nPss:                 321 kB\n";
        assert_eq!(proc_kib(sample, "Rss:"), Some(1_263_616));
        assert_eq!(proc_kib(sample, "Pss:"), Some(328_704));
        assert_eq!(proc_kib(sample, "Missing:"), None);
    }

    #[test]
    fn current_process_capture_is_optional_and_non_panicking() {
        let memory = HostedProcessMemory::capture();
        if let Some(rss) = memory.rss_bytes {
            assert!(rss > 0);
        }
    }
}
