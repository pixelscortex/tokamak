import { contract, type Failure, type MemberHook } from "@tokamak/sdk";

export type SignInFields = Readonly<Record<string, string>>;
export type SignInForm = Readonly<Record<string, "text" | "email" | "password">>;
export type SignInResult = { accountId: string; passwordChangeRequired?: true } | Failure<string, unknown>;
export type SetupOwnerResult = { accountId: string; displayName?: string } | Failure<string, unknown>;

type PasswordChangeResult = { accountId: string } | Failure<string, unknown>;
type NewAccount = { accountId: string; displayName: string } | Failure<string, unknown>;
type AccountForm = {
  createAccountForm: SignInForm;
  createAccount: (input: { memberId: string; fields: SignInFields }) => Promise<NewAccount>;
};
type PasswordManagement = {
  resetPassword?: (input: { accountId: string; password: string }) => Promise<PasswordChangeResult>;
  changePassword?: (input: {
    accountId: string;
    fields: SignInFields;
    newPassword: string;
  }) => Promise<PasswordChangeResult>;
};

export const method = contract<
  {
    id: string;
    name: string;
    form: SignInForm;
    /** Which text or email field identifies the login for sign-in backoff. */
    loginField?: string;
    signIn: (fields: SignInFields) => Promise<SignInResult>;
  } & (
    | { setupOwnerForm: SignInForm; setupOwner: (fields: SignInFields) => Promise<SetupOwnerResult> }
    | { setupOwnerForm?: never; setupOwner?: never }
  ) &
    (AccountForm | { createAccountForm?: never; createAccount?: never }) &
    PasswordManagement
>("method");

export const memberAdded = contract<MemberHook>("memberAdded");
export const memberRemoved = contract<MemberHook>("memberRemoved");
