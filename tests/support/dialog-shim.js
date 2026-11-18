// jsdom does not implement <dialog> (showModal / close / returnValue) or
// <form method="dialog">. This adds just enough of the spec behaviour for the
// unit tests; the real browser behaviour is covered by the e2e tests.
export function installDialogShim() {
  const proto = window.HTMLDialogElement.prototype;
  if (typeof proto.showModal === 'function') return;

  Object.defineProperty(proto, 'returnValue', {
    configurable: true,
    get() { return this._returnValue ?? ''; },
    set(v) { this._returnValue = String(v); },
  });
  proto.showModal = function () { this.setAttribute('open', ''); };
  proto.close = function (value) {
    if (!this.hasAttribute('open')) return;
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };

  // <form method="dialog">: submitting closes the dialog with the submitter's value.
  document.addEventListener('submit', e => {
    const form = e.target;
    if (form.getAttribute('method') !== 'dialog') return;
    e.preventDefault();
    form.closest('dialog')?.close(e.submitter?.value ?? '');
  });
}
