import {render,screen} from "@testing-library/react";
import {expect,it} from "vitest";
import {RequestIdentity} from "./authorization-view";
import type {PendingAuthorization} from "./api";
it("describes a native app as local and unverified without supplied branding",()=>{
  const request={platform:"native",distribution:"web",application_name:"Trusted Brand",homepage:"http://127.0.0.1:49152",icon:"http://127.0.0.1:49152/logo.png",expires_at:new Date(Date.now()+60000).toISOString()} as PendingAuthorization;
  const {container}=render(<RequestIdentity request={request}/>);
  expect(screen.getByRole("heading",{name:"Connect an app"})).toBeInTheDocument();
  expect(screen.getByText("an app running on this computer")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("Application identity unverified. This app calls itself Trusted Brand.");
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByText(/recognize this exact site/)).not.toBeInTheDocument();
});
