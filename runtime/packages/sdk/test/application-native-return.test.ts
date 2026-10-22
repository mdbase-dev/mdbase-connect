import {describe,expect,it} from "vitest";
import {MdbaseConnect,type MdbaseApplicationDeclaration} from "../src/index.js";
import {parseAppManifest} from "@mdbase-dev/connect-protocol/manifest";
const origin="https://app.test",native="dev.tasknotes.entry://auth/mdbase/callback";
/** `legacyRedirects` are appended after parsing, as a declaration stored before
 * manifests refused wildcards would carry them. */
function declaration(redirects:string[]=[`${origin}/callback`,native],legacyRedirects:string[]=[]):MdbaseApplicationDeclaration{
  const manifest=parseAppManifest({manifest_version:1,id:"dev.tasknotes.entry",name:"TaskNotes",homepage:origin,
    redirect_uris:redirects,requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"]}}});
  return{id:"5cdfa020-c201-4da8-845a-f2cc9969eade",name:"TaskNotes",origin,environment:"production",
    manifest:legacyRedirects.length?{...manifest,redirect_uris:[...redirects,...legacyRedirects]}:manifest};
}
const opener=(returnUrl:string)=>({signIn:{open(){},returnUrl}});
describe("sign-in opener return URL (RFC 8252 native redirect)",()=>{
  it("accepts a return URL that exactly equals a declared native or web redirect",()=>{
    expect(()=>new MdbaseConnect(declaration(),opener(native))).not.toThrow();
    expect(()=>new MdbaseConnect(declaration(),opener(`${origin}/callback`))).not.toThrow();
  });
  it("keeps an opener without a return URL valid (extension and popup-less hosts)",()=>{
    expect(()=>new MdbaseConnect(declaration(),{signIn:{open(){}}})).not.toThrow();
  });
  it.each([
    ["another scheme","dev.tasknotes.other://auth/mdbase/callback"],
    ["a foreign scheme","com.example.evil://auth/mdbase/callback"],
    ["another path","dev.tasknotes.entry://auth/mdbase/callback2"],
    ["another host","dev.tasknotes.entry://evil/mdbase/callback"],
    ["http","http://app.test/callback"],
    ["an undeclared wildcard","dev.tasknotes.entry://auth/*"],
    ["an undeclared app-origin URL","capacitor://app.test/callback"],
    ["an undeclared https URL",`${origin}/elsewhere`],
    ["a fragment","dev.tasknotes.entry://auth/mdbase/callback#x"],
  ])("refuses %s",(_case,returnUrl)=>{
    expect(()=>new MdbaseConnect(declaration(),opener(returnUrl))).toThrow(expect.objectContaining({reason:"application_sign_in_opener"}));
  });
  it("never honours a wildcard listed in a legacy declaration, literal or expanded",()=>{
    const app=(returnUrl:string)=>new MdbaseConnect(declaration(undefined,["dev.tasknotes.entry://auth/*"]),opener(returnUrl));
    expect(()=>app(native)).not.toThrow();
    for(const returnUrl of ["dev.tasknotes.entry://auth/*","dev.tasknotes.entry://auth/anything"])
      expect(()=>app(returnUrl)).toThrow(expect.objectContaining({reason:"application_sign_in_opener"}));
  });
  it("refuses a native return URL the app did not declare",()=>{
    expect(()=>new MdbaseConnect(declaration([`${origin}/callback`]),opener(native))).toThrow(expect.objectContaining({reason:"application_sign_in_opener"}));
  });
});
