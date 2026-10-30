import {expect,it} from "vitest";
import {appServerOutcome,appServerProblem} from "../src/app-host/cp-problem.js";
import {AppCpAuthorityError} from "../src/app-host/cp-authority.js";
import {AppCloudCopyBootstrapError} from "../src/app-host/cloud-copy-bootstrap.js";
import {AppInstallationSignInError} from "../src/app-host/installation-sign-in.js";
import {applicationWorkerProblem} from "../src/application/worker-protocol.js";
import {webSignInProblem} from "../src/app-host/web-sign-in-problem.js";
import {parseCollectionAvailability,collectionUnavailableError} from "../src/collection-availability.js";
import {describeError} from "../src/describe-error.js";
import {summarizeStatus} from "../src/status.js";

it.each(["code","reason"])("retains the exact CP %s through sanitized SDK diagnostics and plain copy",field=>{
  const server=appServerProblem(409,{error:{code:field==="code"?"collection_not_yet_migrated":"collection_unavailable",
    message:"private response",details:field==="reason"?{reason:"collection_not_yet_migrated"}:{}}});
  expect(appServerOutcome(server)).toBe("collection_not_yet_migrated");
  const problem=webSignInProblem(new AppCpAuthorityError("collection_not_yet_migrated",server));
  expect(problem).toMatchObject({problem:"collection_not_yet_migrated",detail:{name:"AppCpAuthorityError",code:"collection_not_yet_migrated",server}});
  expect(describeError({status:"blocked",problem:problem.problem,problemDetail:problem.detail})).toMatchObject({
    key:"collection_not_yet_migrated",title:"Your collection needs an upgrade",action:"retry",transient:false,
  });
  expect(JSON.stringify(problem)).not.toContain("private response");
});
it("retains the typed availability across inventory/route parsing and open refusal",()=>{
  const availability={state:"unavailable",reason:"collection_not_yet_migrated"} as const;
  expect(parseCollectionAvailability(availability)).toEqual(availability);
  expect(describeError(collectionUnavailableError(availability.reason))?.key).toBe(availability.reason);
  expect(describeError(availability)?.message).toContain("Your data is safe");
});
it.each(["old_connector_running","desktop_update_required","device_offline","no_device_registered","fenced","forbidden"])("never guesses migration from %s",code=>{
  expect(appServerOutcome(appServerProblem(409,{error:{code}}))).toBeNull();
});
it("carries the bounded outcome across the SDK Worker without server bodies",()=>{
  for(const error of [
    new AppInstallationSignInError("collection_not_yet_migrated"),
    new AppCpAuthorityError("collection_not_yet_migrated"),
    new AppCloudCopyBootstrapError("collection_not_yet_migrated"),
    collectionUnavailableError("collection_not_yet_migrated"),
  ]) expect(applicationWorkerProblem(error)).toEqual({code:"collection_not_yet_migrated"});
  expect(applicationWorkerProblem({reason:"collection_not_yet_migrated",message:"private"})).toEqual({code:"application_worker_unavailable"});
});
it("keeps live typed sync status and pending edits distinct from offline",()=>{
  expect(summarizeStatus({mode:"synced",confirmedThrough:5,headKnown:5,pending:1,holds:0,unresolved:0,connection:"offline",incidents:[]},"collection_not_yet_migrated")).toMatchObject({
    kind:"collection_not_yet_migrated",pending:1,
  });
});
