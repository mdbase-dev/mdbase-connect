Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("[data-autofocus], button, input")?.focus();
  },
  close(this: HTMLDialogElement) { this.removeAttribute("open"); }
});
