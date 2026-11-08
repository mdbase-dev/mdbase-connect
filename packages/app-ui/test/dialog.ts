Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("[data-autofocus], button, input")?.focus();
  },
  close(this: HTMLDialogElement) { this.removeAttribute("open"); }
});
HTMLElement.prototype.showPopover = function () { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.checkVisibility = function () { return !this.closest("[hidden]"); };
HTMLElement.prototype.getAnimations = function () { return []; };
