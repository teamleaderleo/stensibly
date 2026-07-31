export {};

declare global {
  interface HTMLElement {
    /** Present on labelable form controls; browser evidence checks it only after a runtime property guard. */
    readonly labels?: NodeListOf<HTMLLabelElement> | null;
  }
}
