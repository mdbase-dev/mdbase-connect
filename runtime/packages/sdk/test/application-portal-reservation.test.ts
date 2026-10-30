import {afterEach,describe,expect,it,vi} from "vitest";
import {reserveApplicationPortal,browserApplicationPortalHost,openerApplicationPortalHost,ApplicationPortalError,type ApplicationPortalHost} from "../src/application/portal-reservation.js";
const cpOrigin="https://cp.test",uri=`${cpOrigin}/pair/11111111-1111-4111-8111-111111111111`;
function fixture(){const caller=new AbortController(),popup={navigate:vi.fn(),close:vi.fn(),focus:vi.fn()},open=vi.fn(()=>popup),current=vi.fn(()=>true);const host:ApplicationPortalHost={cpOrigin,signal:caller.signal,open,isCurrent:current};return{host,caller,popup,open,current};}
afterEach(()=>vi.unstubAllGlobals());
describe("SDK-private original gesture popup reservation",()=>{
  it("reserves synchronously before startup can run and navigates only the same authenticated CP origin",()=>{
    const f=fixture(),trace:string[]=[];f.open.mockImplementation(()=>{trace.push("open");return f.popup;});
    const portal=reserveApplicationPortal(f.host);trace.push("startup");expect(trace).toEqual(["open","startup"]);expect(f.open).toHaveBeenCalledOnce();
    portal.navigate(uri);expect(f.popup.navigate).toHaveBeenCalledExactlyOnceWith(uri);portal.close();portal.close();expect(f.popup.close).toHaveBeenCalledOnce();
  });
  it("focus preserves the original reservation and caller fencing without navigation or replacement",()=>{
    const f=fixture(),portal=reserveApplicationPortal(f.host);portal.navigate(uri);portal.focus();
    expect(f.popup.focus).toHaveBeenCalledOnce();expect(f.open).toHaveBeenCalledOnce();expect(f.popup.navigate).toHaveBeenCalledOnce();expect(f.popup.close).not.toHaveBeenCalled();
    f.caller.abort();expect(()=>portal.focus()).toThrow(ApplicationPortalError);expect(f.popup.focus).toHaveBeenCalledOnce();
  });
  it("blocked popup is a typed reason, not raw message matching or startup work",()=>{
    const f=fixture(),startup=vi.fn();const host={...f.host,open:()=>null};
    try{reserveApplicationPortal(host);startup();throw Error("expected blocked");}catch(error){expect(error).toBeInstanceOf(ApplicationPortalError);expect(error).toMatchObject({reason:"application_popup_blocked"});}
    expect(startup).not.toHaveBeenCalled();expect(f.popup.close).not.toHaveBeenCalled();
  });
  it("canceled before reserve never opens; canceled during ignored-abort open owns and closes the late popup",()=>{
    const f=fixture();f.caller.abort();expect(()=>reserveApplicationPortal(f.host)).toThrow(ApplicationPortalError);expect(f.open).not.toHaveBeenCalled();
    const late=fixture();late.open.mockImplementation(()=>{late.caller.abort();return late.popup;});expect(()=>reserveApplicationPortal(late.host)).toThrow(ApplicationPortalError);expect(late.popup.close).toHaveBeenCalledOnce();
  });
  it.each(["https://foreign.test/pair/x","https://user:credential@cp.test/pair/x"])("rejects foreign or credential-bearing navigation %s",bad=>{
    const f=fixture(),portal=reserveApplicationPortal(f.host);expect(()=>portal.navigate(bad)).toThrow(ApplicationPortalError);expect(f.popup.navigate).not.toHaveBeenCalled();portal.close();
  });
  it("sanitizes popup exceptions and memoizes a failed physical close without retry/reuse",()=>{
    const f=fixture(),portal=reserveApplicationPortal(f.host);f.popup.close.mockImplementation(()=>{throw Error("private response secret");});let original:unknown;
    try{portal.close();}catch(error){original=error;}expect(original).toMatchObject({reason:"application_popup_stop_failed"});expect(String(original)).not.toContain("secret");
    try{portal.close();}catch(error){expect(error).toBe(original);}expect(f.popup.close).toHaveBeenCalledOnce();expect(()=>reserveApplicationPortal(f.host)).toThrow(ApplicationPortalError);expect(f.popup.close).toHaveBeenCalledOnce();
  });
  it("default SDK browser adapter opens blank/_blank synchronously; no app supplied callback",()=>{
    const popup={location:{href:"about:blank"},close:vi.fn(),closed:false},open=vi.fn(()=>popup),focus=vi.fn();vi.stubGlobal("window",{open,focus});const signal=new AbortController().signal;
    const portal=reserveApplicationPortal(browserApplicationPortalHost(cpOrigin,signal,()=>true));expect(open).toHaveBeenCalledExactlyOnceWith("about:blank","_blank",expect.stringMatching(/^popup,width=620,height=760,left=\d+,top=\d+$/));portal.navigate(uri);expect(popup.location.href).toBe(uri);portal.close();expect(popup.close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce(); // closing the approval window returns focus to the app
  });
  it("HTTP requires SDK-authenticated explicit loopback, never a remote or implicit fallback",()=>{
    const f=fixture();expect(()=>reserveApplicationPortal({...f.host,cpOrigin:"http://localhost:1234"})).toThrow(ApplicationPortalError);expect(f.open).not.toHaveBeenCalled();
    expect(()=>reserveApplicationPortal({...f.host,cpOrigin:"http://cp.test",allowLoopbackHttp:true})).toThrow(ApplicationPortalError);expect(f.open).not.toHaveBeenCalled();
    const portal=reserveApplicationPortal({...f.host,cpOrigin:"http://localhost:1234",allowLoopbackHttp:true});portal.navigate("http://localhost:1234/pair/123");portal.close();
  });
  it("default browser adapter retains original window identity and fences a self-closed popup",()=>{
    const popup={closed:false,location:{href:"about:blank"},close:vi.fn()},open=vi.fn(()=>popup);vi.stubGlobal("window",{open});const signal=new AbortController().signal;
    const host=browserApplicationPortalHost(cpOrigin,signal,()=>true),portal=reserveApplicationPortal(host);popup.closed=true;
    expect(()=>portal.navigate(uri)).toThrow(ApplicationPortalError);expect(popup.location.href).toBe("about:blank");portal.close();
    expect(()=>reserveApplicationPortal(host)).toThrow(ApplicationPortalError);expect(popup.close).toHaveBeenCalledOnce();
  });
  it("public signIn opener receives the CP-bound URL with return_url and is dismissed on close",async()=>{
    const opener={open:vi.fn(),close:vi.fn(),returnUrl:"capacitor://app.tasknotes.dev/signed-in"},signal=new AbortController().signal;
    const portal=reserveApplicationPortal(openerApplicationPortalHost(cpOrigin,signal,()=>true,opener));
    expect(opener.open).not.toHaveBeenCalled();
    expect(()=>portal.navigate("https://foreign.test/pair/x")).toThrow(ApplicationPortalError);
    portal.navigate(uri);await Promise.resolve();await Promise.resolve();
    const opened=new URL(opener.open.mock.calls[0]![0]);expect(opened.origin).toBe(cpOrigin);expect(opened.searchParams.get("return_url")).toBe(opener.returnUrl);
    portal.close();await Promise.resolve();await Promise.resolve();expect(opener.close).toHaveBeenCalledOnce();expect(opener.open).toHaveBeenCalledOnce();
  });
  it("an opener without returnUrl gets the CP URL with no return_url (CP keeps the user on its own page)",async()=>{
    const opener={open:vi.fn()},portal=reserveApplicationPortal(openerApplicationPortalHost(cpOrigin,new AbortController().signal,()=>true,opener));
    portal.navigate(uri);await Promise.resolve();await Promise.resolve();
    expect(new URL(opener.open.mock.calls[0]![0]).searchParams.has("return_url")).toBe(false);
  });
});
