import type { MdbaseFirstContactChallenge } from "@mdbase-dev/connect";
import { useId } from "react";
import { Dialog } from "./Dialog";

export function FirstContactDialog({ challenge, onCancel }: {
  challenge: MdbaseFirstContactChallenge;
  onCancel(): void;
}) {
  const titleId = useId();
  return <Dialog
    titleId={titleId}
    className="confirm-dialog first-contact-dialog"
    role="alertdialog"
    onClose={onCancel}
  >
    <div className="confirm-dialog-copy">
      <h2 id={titleId}>Verify this application</h2>
      <div>
        <p>Compare this code with the code shown by mdbase connect on the computer hosting the collection.</p>
        <code className="first-contact-code">{challenge.authenticationString}</code>
        <p>Accept only an exact match. For a headless connector, run <code>mdbase connect trust list</code>, then accept the request with this code.</p>
      </div>
    </div>
    <footer>
      <span role="status">Waiting for local confirmation…</span>
      <button onClick={onCancel}>Cancel authorization</button>
    </footer>
  </Dialog>;
}
