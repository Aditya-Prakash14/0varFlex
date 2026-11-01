// extensions/toy-debug/src/program.ts — the "language" the toy debugger debugs: one statement
// per line, operating on a single integer counter.
//
// Pure, so the stepping semantics are unit tested (tests/toyDebugProgram.test.ts) without
// spawning an adapter. The DAP plumbing is the interesting part of A2-2; this is just something
// real enough to stop at a breakpoint and show a variable that changes.
//
// Syntax (blank lines and `#` comments are skipped but keep their line numbers):
//   inc        counter += 1
//   inc <n>    counter += n
//   dec        counter -= 1
//   dec <n>    counter -= n
//   set <n>    counter = n
//   print      emit the counter as DAP output

export type ProgramOp = 'inc' | 'dec' | 'set' | 'print';

export interface IProgramLine {
	/** 1-based, matching the file — this is what breakpoints and stack frames refer to */
	readonly lineNumber: number;
	readonly op: ProgramOp;
	readonly operand?: number;
	readonly text: string;
}

export interface IProgramError {
	readonly lineNumber: number;
	readonly message: string;
}

export interface IParsedProgram {
	readonly lines: readonly IProgramLine[];
	readonly errors: readonly IProgramError[];
}

/**
 * Parse a program. Executable lines keep their ORIGINAL line numbers, so a breakpoint on a blank
 * line simply never matches rather than shifting execution onto the wrong statement.
 */
export function parseProgram(text: string): IParsedProgram {
	const lines: IProgramLine[] = [];
	const errors: IProgramError[] = [];

	const rawLines = text.split('\n');
	for (let i = 0; i < rawLines.length; i++) {
		const lineNumber = i + 1;
		const trimmed = rawLines[i].replace(/\r$/, '').trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const [word, ...rest] = trimmed.split(/\s+/);
		const op = word.toLowerCase();

		if (op === 'print') {
			lines.push({ lineNumber, op: 'print', text: trimmed });
			continue;
		}
		if (op !== 'inc' && op !== 'dec' && op !== 'set') {
			errors.push({ lineNumber, message: `unknown statement '${word}'` });
			continue;
		}

		if (rest.length === 0) {
			if (op === 'set') {
				errors.push({ lineNumber, message: "'set' needs a value" });
				continue;
			}
			lines.push({ lineNumber, op, operand: 1, text: trimmed });
			continue;
		}

		const operand = Number(rest[0]);
		if (!Number.isInteger(operand)) {
			errors.push({ lineNumber, message: `'${rest[0]}' is not an integer` });
			continue;
		}
		lines.push({ lineNumber, op, operand, text: trimmed });
	}

	return { lines, errors };
}

export interface IStepResult {
	readonly counter: number;
	/** text to surface as DAP `output`, if the statement produced any */
	readonly output?: string;
}

/** execute one statement against the counter */
export function applyLine(counter: number, line: IProgramLine): IStepResult {
	switch (line.op) {
		case 'inc':
			return { counter: counter + (line.operand ?? 1) };
		case 'dec':
			return { counter: counter - (line.operand ?? 1) };
		case 'set':
			return { counter: line.operand ?? 0 };
		case 'print':
			return { counter, output: `counter = ${counter}\n` };
		default:
			return { counter };
	}
}

/**
 * Run from `index` until a breakpoint line is reached or the program ends.
 *
 * The breakpoint check happens BEFORE executing a line — stopping "at" line N means line N has
 * not run yet, which is what a debugger user expects. The starting index is always executed, so
 * `continue` from a breakpoint makes progress instead of stopping on the same line forever.
 */
export function runUntilBreakpoint(
	lines: readonly IProgramLine[],
	startIndex: number,
	counter: number,
	breakpointLines: ReadonlySet<number>
): { index: number; counter: number; outputs: string[]; stoppedAtBreakpoint: boolean } {
	let index = startIndex;
	let current = counter;
	const outputs: string[] = [];

	while (index < lines.length) {
		// the first line of a run always executes (otherwise continue would never leave)
		if (index !== startIndex && breakpointLines.has(lines[index].lineNumber)) {
			return { index, counter: current, outputs, stoppedAtBreakpoint: true };
		}
		const result = applyLine(current, lines[index]);
		current = result.counter;
		if (result.output) {
			outputs.push(result.output);
		}
		index++;
	}

	return { index, counter: current, outputs, stoppedAtBreakpoint: false };
}

/** the first index at or after `from` whose line carries a breakpoint */
export function firstBreakpointIndex(lines: readonly IProgramLine[], breakpointLines: ReadonlySet<number>, from = 0): number {
	for (let i = from; i < lines.length; i++) {
		if (breakpointLines.has(lines[i].lineNumber)) {
			return i;
		}
	}
	return -1;
}
