import {describe,expect,it} from "vitest";
import {applicationDeclaration,rebindApplicationDeclaration} from "../src/application/declaration.js";
const native="5cdfa020-c201-4da8-845a-f2cc9969eade",base={id:"dev.tasknotes.web",name:"TaskNotes",origin:"https://tasknotes.test",environment:"lab" as const,manifest:{manifest_version:1,id:"dev.tasknotes.web",name:"TaskNotes"}};
describe("SDK registered declaration storage custody",()=>{
 it("fresh logical defaults derive registered native binding, never allocate under logical id",()=>{
  const original=applicationDeclaration(base),bound=rebindApplicationDeclaration(original,{id:native,name:"TaskNotes"});expect(bound.id).toBe(native);expect(bound.storage).toEqual({joinDatabaseName:`mdbase.${native}.native-collection-join.v1`,setupDatabaseName:`mdbase.${native}.native-model-setup.v1`,applicationNamespace:native});expect(original.id).toBe(base.id);expect(bound.manifest).toEqual(original.manifest);
 });
 it("preserves only exact explicit overrides, including values equal to prior logical defaults",()=>{
  const supplied=applicationDeclaration({...base,storage:{joinDatabaseName:"tasknotes.native-collection-join.v1",applicationNamespace:base.id}}),bound=rebindApplicationDeclaration(supplied,{id:native,name:"TaskNotes"});expect(bound.storage).toEqual({joinDatabaseName:"tasknotes.native-collection-join.v1",setupDatabaseName:`mdbase.${native}.native-model-setup.v1`,applicationNamespace:base.id});
 });
});
