/** The source may not be called before `until`; nothing was called. */
export class ResearchSourceWaitError extends Error {
  constructor(
    readonly source: string,
    readonly until: Date,
    readonly reason: string,
  ) {
    super(`${reason}; ${source} can be used again at ${until.toISOString().slice(0, 16).replace("T", " ")} UTC`);
    this.name = "ResearchSourceWaitError";
  }
}

/** The source's API failed (network, HTTP error, unreadable answer): the page may still be read another way. */
export class ResearchSourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
    this.name = "ResearchSourceError";
  }
}
