export const PASSWORD_ERROR = "رمز جدید باید حداقل ۴ کاراکتر باشد.";

// Product policy: no character-class requirement; existing long passwords remain valid.
export function isValidPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 4;
}
