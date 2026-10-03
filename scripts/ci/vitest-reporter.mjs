import { recordFailure } from "./flake-report.mjs";

export default class FlakeReporter {
  onTestRunEnd(modules, errors) {
    for (const module of modules) {
      if (module.state() === "failed" && ![...module.children.allTests("failed")].length) {
        recordFailure({ suite: module.moduleId, test: "<collection/hook failure>", recovered: false });
      }
    }
    for (const error of errors) {
      recordFailure({ suite: "vitest", test: "<unhandled error>", recovered: false, errors: [{ message: error.message, stack: error.stack }] });
    }
  }
  onTestCaseResult(test) {
    const retries = test.diagnostic()?.retryCount ?? 0;
    const result = test.result();
    if (!retries && result.state !== "failed") return;
    recordFailure({
      suite: test.module.moduleId,
      test: test.fullName,
      retries,
      recovered: retries > 0 && result.state === "passed",
      errors: result.errors?.map((error) => ({ message: error.message, stack: error.stack }))
    });
  }
}
