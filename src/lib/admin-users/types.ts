export interface AdminUserAccessRow {
  email: string;
  name: string | null;
  disabled: boolean;
  accessVersion: number;
  isOwner: boolean;
}

export interface AdminAccessEnvironment extends Record<string, string | undefined> {
  SUPER_ADMIN_EMAILS?: string;
}

export class AdminUsersAccessError extends Error {
  constructor(message: string, public readonly status: 401 | 403 | 404 | 409) {
    super(message);
    this.name = "AdminUsersAccessError";
  }
}
