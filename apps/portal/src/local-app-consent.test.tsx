import {render,screen} from "./test/render";
import {expect,it} from "vitest";
import {RequestIdentity} from "./authorization-view";
import type {PendingAuthorization} from "./api";
it.each(["Trusted Brand", "<0/>", "<b>x</b>", String.raw`name\path`])("describes local app %s as unverified without supplied branding",application_name=>{
  const request={distribution:"web",application_name,homepage:"http://127.0.0.1:49152",application_origin:"http://127.0.0.1:49152",icon:"http://127.0.0.1:49152/logo.png",expires_at:new Date(Date.now()+60000).toISOString()} as PendingAuthorization;
  const {container}=render(<RequestIdentity request={request}/>);
  expect(screen.getByRole("heading",{name:"Connect an app"})).toBeInTheDocument();
  expect(screen.getByText("an app running on this computer")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent(`App identity unverified. This app calls itself ${application_name}.`);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByText(/recognize this exact site/)).not.toBeInTheDocument();
});

it.each(["http://localhost:5173", "http://[::1]:5173", "http://127.0.0.1"])("gives an app under development at %s the same local treatment",application_origin=>{
  const request={distribution:"web",application_name:"Worklog",homepage:application_origin,application_origin,icon:`${application_origin}/icon.png`,expires_at:new Date(Date.now()+60000).toISOString()} as PendingAuthorization;
  const {container}=render(<RequestIdentity request={request}/>);
  expect(screen.getByRole("heading",{name:"Connect an app"})).toBeInTheDocument();
  expect(screen.getByText("an app running on this computer")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("App identity unverified. This app calls itself Worklog.");
  expect(container.querySelector("img")).toBeNull();
});

it.each(["https://remote.example.test", "https://localhost:5173", "http://localhost.example.test", "http://127.0.0.2:5173", "http://localhost:5173/path", "null", undefined])("shows web consent and the actual origin for %s",application_origin=>{
  const request={distribution:"web",application_name:"Claimed Local",homepage:"http://127.0.0.1:49152",application_origin,expires_at:new Date(Date.now()+60000).toISOString()} as PendingAuthorization;
  render(<RequestIdentity request={request}/>);
  expect(screen.queryByText("an app running on this computer")).not.toBeInTheDocument();
  if (application_origin) {
    expect(screen.getByText(/Continue only if you started this and recognize this site\./)).toBeInTheDocument();
    expect(screen.getByText(application_origin)).toBeInTheDocument();
  } else expect(screen.getByText(/No requesting origin is available\./)).toBeInTheDocument();
});
