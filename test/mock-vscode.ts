export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
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
  private readonly listeners = new Set<() => void>();
  private cancelled = false;
  readonly token = {
    get isCancellationRequested() {
      return this.source.cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
    source: this,
  };

  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

export class CancellationError extends Error {}

export const lm: {
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: object;
    tags: string[];
  }>;
  invokeTool: (
    name: string,
    options: unknown,
    token?: unknown,
  ) => Promise<LanguageModelToolResult>;
} = {
  tools: [],
  async invokeTool(name) {
    throw new Error(`No mock implementation for ${name}`);
  },
};

export const extensions: { all: unknown[] } = { all: [] };
export const version = "1.105.0-test";

export const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
};

function normalize(content: string | unknown[]): unknown[] {
  return typeof content === "string" ? [new LanguageModelTextPart(content)] : content;
}
