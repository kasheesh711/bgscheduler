export class PostClassConflictError extends Error {
  constructor(message = "This record changed. Refresh and try again.") {
    super(message);
    this.name = "PostClassConflictError";
  }
}

export class PostClassValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostClassValidationError";
  }
}

export class PostClassNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostClassNotFoundError";
  }
}
