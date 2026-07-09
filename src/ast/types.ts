export interface AstSourcePosition {
    start: {
        offset: number;
        line: number;
        column: number;
    };
    end: {
        offset: number;
        line: number;
        column: number;
    };
}

export interface SnaptexAstArgument {
    type: 'argument';
    openMark: string;
    closeMark: string;
    content: SnaptexAstNode[];
    position?: AstSourcePosition;
}

export interface SnaptexAstNode {
    type: string;
    content?: string | SnaptexAstNode[];
    env?: string | { type: string; content?: string };
    args?: SnaptexAstArgument[];
    position?: AstSourcePosition;
}

export interface SnaptexAstRoot extends SnaptexAstNode {
    type: 'root';
    content: SnaptexAstNode[];
}

export interface AstParseError {
    message: string;
    line?: number;
    column?: number;
}

export interface AstParseResult {
    ast?: SnaptexAstRoot;
    errors: AstParseError[];
}
