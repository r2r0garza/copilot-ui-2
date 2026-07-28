export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelChatMessage {
  static User(content: string | unknown[]) {
    return { role: "user", content: normalize(content) };
  }

  static Assistant(content: string | unknown[]) {
    return { role: "assistant", content: normalize(content) };
  }
}

export class CancellationTokenSource {
  readonly token = {};
  cancel() {}
  dispose() {}
}

export const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
};

function normalize(content: string | unknown[]): unknown[] {
  return typeof content === "string" ? [new LanguageModelTextPart(content)] : content;
}
