class JobError(Exception):
    """An expected failure. `message` is shown to the user, so keep it plain and helpful."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class JobCancelled(Exception):
    """The user cancelled the job; stop as soon as possible."""
