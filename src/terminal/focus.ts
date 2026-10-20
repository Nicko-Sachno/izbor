export const HELP_FOCUS = "@help";
export const DETAIL_FOCUS = "@brief";
export const FIELD_FOCUS = "@field";
const PROJECT_FOCUS = "@project ";
export const projectFocus = (checkout: string) => `${PROJECT_FOCUS}${checkout}`;
export const focusedCheckout = (focused: string | null) =>
    focused?.startsWith(PROJECT_FOCUS) ? focused.slice(PROJECT_FOCUS.length) : undefined;
