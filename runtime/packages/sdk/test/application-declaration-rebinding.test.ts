import {describe,expect,it} from "vitest";
import {storageNamespaceDigest} from "../src/application/storage-scope.js";
import {applicationDeclaration,rebindApplicationDeclaration} from "../src/application/declaration.js";
const native="5cdfa020-c201-4da8-845a-f2cc9969eade",base={id:"dev.tasknotes.web",name:"TaskNotes",origin:"https://tasknotes.test",environment:"lab" as const,manifest:{manifest_version:1,id:"dev.tasknotes.web",name:"TaskNotes"}};
describe("SDK registered declaration storage custody",()=>{
 it("fresh logical defaults derive registered native binding, never allocate under logical id",()=>{
  const original=applicationDeclaration(base),bound=rebindApplicationDeclaration(original,{id:native,name:"TaskNotes"});expect(bound.id).toBe(native);expect(bound.storage).toEqual({joinDatabaseName:`mdbase.${native}.native-collection-join.v1`,setupDatabaseName:`mdbase.${native}.native-model-setup.v1`,applicationNamespace:native});expect(original.id).toBe(base.id);expect(bound.manifest).toEqual(original.manifest);
 });
 it("keeps storage derived from a superseded declared UUID when the manifest changed",()=>{
  const declared="33333333-3333-4333-8333-333333333333",original=applicationDeclaration({...base,id:declared}),bound=rebindApplicationDeclaration(original,{id:native,name:"TaskNotes",supersededDeclaredId:declared});
  expect(bound.id).toBe(native);expect(bound.storage).toEqual({joinDatabaseName:`mdbase.${declared}.native-collection-join.v1`,setupDatabaseName:`mdbase.${declared}.native-model-setup.v1`,applicationNamespace:declared});
  expect(()=>rebindApplicationDeclaration(original,{id:native,name:"TaskNotes",supersededDeclaredId:native})).toThrow();
 });
 it("preserves only exact explicit overrides, including values equal to prior logical defaults",()=>{
  const supplied=applicationDeclaration({...base,storage:{joinDatabaseName:"tasknotes.native-collection-join.v1",applicationNamespace:base.id}}),bound=rebindApplicationDeclaration(supplied,{id:native,name:"TaskNotes"});expect(bound.storage).toEqual({joinDatabaseName:"tasknotes.native-collection-join.v1",setupDatabaseName:`mdbase.namespace.${storageNamespaceDigest(JSON.stringify([native,base.id]))}.native-model-setup.v1`,applicationNamespace:base.id});
 });
});
