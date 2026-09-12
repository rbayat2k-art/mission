# 004 — Simple password policy

## Status
Accepted by product owner, 2026-09-12. Release 2.10.5.

## Context and decision
The owner explicitly requested four-character passwords, letters only, numbers only or mixed, without uppercase/symbol requirements. Interpret four as the minimum, not an exact length; existing longer passwords remain valid. All four server password-setting endpoints use the same string/minimum-length validator; UI help matches. No automatic password reset or migration is performed.

## Consequences
This is a deliberate reduction in password strength, especially for four-digit passwords; it is not a security improvement. Existing login throttling, PBKDF2 hashing, current-password verification for account edits, confirmation checks, authorization and session rotation remain unchanged. Symbols and Persian characters are allowed. No transformation/trimming is introduced. Admin-generated passwords may remain longer; the generator is optional.

## Validation
Unit coverage includes numeric, alphabetic, mixed, Persian, long, too-short and non-string values; real change-password handler with isolated dependencies tests successful updates, confirmation mismatch and cached Android clients. Desktop/mobile tests verify the short value can be submitted. Release gates remain lint, typecheck, unit, build, E2E and online audit. No production credentials are used for tests.
