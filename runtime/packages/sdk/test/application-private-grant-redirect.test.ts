import {describe,expect,it,vi} from "vitest";

const constructed:Array<{redirectUri:string}>=[];
vi.mock("../src/app-grant/client.js",()=>({
  MdbaseAppGrants:class{constructor(options:{redirectUri:string}){constructed.push(options);}},
}));
const {ApplicationPrivateCollections}=await import("../src/application/private-collections.js");

const origin="https://app.test";
const declaration={id:"5cdfa020-c201-4da8-845a-f2cc9969eade",name:"TaskNotes",origin,environment:"production" as const,
  manifest:{redirect_uris:[`${origin}/callback`,`${origin}/native-grant`]}} as never;

async function redirectFor(grantRedirectUri?:string):Promise<string>{
  constructed.length=0;
  const privates=new ApplicationPrivateCollections({declaration,onChange(){},...(grantRedirectUri?{grantRedirectUri}:{})});
  await (privates as unknown as {grants():Promise<unknown>}).grants();
  return constructed[0]!.redirectUri;
}

describe("Private grant redirect",()=>{
  it("returns to the first declared redirect on the origin by default",async()=>{
    expect(await redirectFor()).toBe(`${origin}/callback`);
  });
  it("returns to the sign-in opener's grant return URL when it names one",async()=>{
    expect(await redirectFor(`${origin}/native-grant`)).toBe(`${origin}/native-grant`);
  });
});
