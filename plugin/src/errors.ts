export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayProtocolError';
  }
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

export class RelayFatalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelayFatalError';
    this.code = code;
  }
}

export class Layer2ResponseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Layer2ResponseError';
    this.code = code;
  }
}
