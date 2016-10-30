/// <reference types="es6-collections" />
/// <reference types="node" />

import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename} from 'path';
import * as ChildProcess from "child_process"


/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {

	scriptPath: string;
	commandLineArguments: string;
}

class BashDebugSession extends DebugSession {

	private static THREAD_ID = 42;
	private static BASHDB_PROMPT = "#";

	protected process: ChildProcess.ChildProcess;

	private _variableHandles = new Handles<string>();

	private _fullDebugOutput = [""];
	private _fullDebugOutputIndex = 0;

	private _debuggerExecutableBusy = false;

	private _responsivityFactor = 1;

	public constructor() {
		super();
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		response.body.supportsConfigurationDoneRequest = false; //TODO: implement configDone if needed
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsStepBack = false;
		response.body.supportsSetVariable = false;
		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		this.process = ChildProcess.spawn("bash", ["-c", `bashdb --quiet -- "${args.scriptPath}" ${args.commandLineArguments}`]);
		this.process.stdin.write(`print '${BashDebugSession.BASHDB_PROMPT}'\n`);

		this.process.stdout.on("data", (data) =>
		{
			this.sendEvent(new OutputEvent(`${data}`));

			var list = data.toString().split("\n", -1);
			var fullLine = `${this._fullDebugOutput.pop()}${list.shift()}`;
			this._fullDebugOutput.push(fullLine);
			this._fullDebugOutput = this._fullDebugOutput.concat(list);
		});

		this.process.stderr.on("data", (data)=>
		{
			this.sendEvent(new OutputEvent(`stderr: ${data}\n`));
		});

		this.process.on("exit", (() => { this.emit("quit"); }).bind(this));

		setTimeout(()=>this.launchRequestFinalize(response, args), this._responsivityFactor);
	}

	private launchRequestFinalize(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		for (var i = 0; i < this._fullDebugOutput.length; i++) {
			if (this._fullDebugOutput[i] == BashDebugSession.BASHDB_PROMPT) {

				this.sendResponse(response);
				this.sendEvent(new InitializedEvent());

				this.process.stdout.on("data", (data) => {
				for (; this._fullDebugOutputIndex < this._fullDebugOutput.length - 1; this._fullDebugOutputIndex++)
					{
						var line = this._fullDebugOutput[this._fullDebugOutputIndex];

						if (line.indexOf("(/") == 0 && line.indexOf("):") == line.length-2)
						{
							this.sendEvent(new StoppedEvent("break", BashDebugSession.THREAD_ID));
						}
						else if (line.indexOf("terminated") > 0 )
						{
							this.sendEvent(new TerminatedEvent());
							this.process.stdin.write(`quit\n\n`)
						}
					}
				});
				return;
			}
		}

		setTimeout(()=>this.launchRequestFinalize(response, args), this._responsivityFactor);
	}


	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.setBreakPointsRequest(response, args), this._responsivityFactor);
			return;
		}

		var setBreakpointsCommand = `delete\n`;
		args.breakpoints.forEach((b)=>{ setBreakpointsCommand += `print ' <${args.source.path}:${b.line}> '\nbreak ${args.source.path}:${b.line}\n` });

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`${setBreakpointsCommand}print '${BashDebugSession.BASHDB_PROMPT}'\n`);
		setTimeout(()=>	this.setBreakPointsRequestFinalize(response, args, currentLine), this._responsivityFactor);
	}

	private setBreakPointsRequestFinalize(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, currentOutputLength:number): void {
		this.sendResponse(response);

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length - 2] == BashDebugSession.BASHDB_PROMPT){

			var breakpoints = new Array<Breakpoint>();

			for (var i = currentOutputLength; i < this._fullDebugOutput.length - 2; i++ ){

				if (this._fullDebugOutput[i-1].indexOf(" <") == 0 && this._fullDebugOutput[i-1].indexOf("> ") > 0) {

					var lineNodes = this._fullDebugOutput[i].split(" ");
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, this.convertDebuggerLineToClient(parseInt(lineNodes[lineNodes.length-1].replace(".",""))));
					bp.id = parseInt(lineNodes[1]);
					breakpoints.push(bp);
				}
			}

			response.body = { breakpoints: breakpoints };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		setTimeout(()=> this.setBreakPointsRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		response.body = {
			threads: [
				new Thread(BashDebugSession.THREAD_ID, "Bash-Super-Thread")
			]
		};

		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.stackTraceRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`backtrace\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);
		setTimeout(() => this.stackTraceRequestFinalize(response, args, currentLine), this._responsivityFactor);
	}

	private stackTraceRequestFinalize(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, currentOutputLength:number): void {

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT){

			var lastStackLineIndex = this._fullDebugOutput.length - 3;

			const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
			const maxLevels = typeof args.levels === 'number' ? args.levels : 100;

			const frames = new Array<StackFrame>();
			for (var i= currentOutputLength - 1; i <= lastStackLineIndex ; i++) {
				var lineContent = this._fullDebugOutput[i];
				var frameIndex = parseInt(lineContent.substr(2, 2));
				var frameText = lineContent;
				var frameSourcePath = lineContent.substr(lineContent.lastIndexOf("`") + 1, lineContent.lastIndexOf("'") - lineContent.lastIndexOf("`") - 1);
				var frameLine = parseInt(lineContent.substr(lineContent.lastIndexOf(" ")));

				frames.push(new StackFrame(
					frameIndex,
					frameText,
					new Source(basename(frameSourcePath), this.convertDebuggerPathToClient(frameSourcePath)),
					this.convertDebuggerLineToClient(frameLine)
					));
			}

			var totalFrames = this._fullDebugOutput.length - currentOutputLength -1;

			response.body = { stackFrames: frames, totalFrames: totalFrames };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		setTimeout(() => this.stackTraceRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		response.body = { scopes: scopes };
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.variablesRequest(response, args), this._responsivityFactor);
			return;
		}

		var getVariablesCommand = `info program\n`;
		["PWD","0","1","2","3","4","5","6","7","8","9"].forEach((v)=>{ getVariablesCommand += `print ' <$${v}> '\nexamine $${v}\n` });

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`${getVariablesCommand}print '${BashDebugSession.BASHDB_PROMPT}'\n`);
		setTimeout(()=> this.variablesRequestFinalize(response, args, currentLine), this._responsivityFactor);
	}

	private variablesRequestFinalize(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, currentOutputLength:number): void {

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT){

			var variables = [];

			for (var i = currentOutputLength; i < this._fullDebugOutput.length - 2; i++ ){

				if (this._fullDebugOutput[i-1].indexOf(" <") == 0 && this._fullDebugOutput[i-1].indexOf("> ") > 0) {

					var lineNodes = this._fullDebugOutput[i].split(" ");
					variables.push({
						name: `${this._fullDebugOutput[i-1].replace(" <", "").replace("> ", "")}`,
						type: "string",
						value: this._fullDebugOutput[i],
						variablesReference: 0
					});
				}
			}

			response.body = { variables: variables };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		setTimeout(()=> this.variablesRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.continueRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`continue\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);

		setTimeout(()=>this.continueRequestFinalize(response, args, currentLine), this._responsivityFactor);

		// TODO: why does it need to be here?
		this.sendResponse(response);
	}

	private continueRequestFinalize(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, currentOutputLength:number): void {

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT)
		{
			this._debuggerExecutableBusy = false;
			//this.sendResponse(response);
			return;
		}

		setTimeout(()=>this.continueRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.nextRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`next\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);

		setTimeout(()=>this.nextRequestFinalize(response, args, currentLine), this._responsivityFactor);

		// TODO: why does it need to be here?
		this.sendResponse(response);
	}

	private nextRequestFinalize(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, currentOutputLength:number): void {

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT)
		{
			this._debuggerExecutableBusy = false;
			//this.sendResponse(response);
			return;
		}

		setTimeout(()=>this.nextRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.stepInRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`step\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);

		setTimeout(()=>this.stepInRequestFinalize(response, args, currentLine), this._responsivityFactor);

		// TODO: why does it need to be here?
		this.sendResponse(response);
	}

	private stepInRequestFinalize(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, currentOutputLength:number): void {
		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT)
		{
			this._debuggerExecutableBusy = false;
			//this.sendResponse(response);
			return;
		}

		setTimeout(()=>this.stepInRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.stepBackRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`step -\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);

		setTimeout(()=>this.stepBackRequestFinalize(response, args, currentLine), this._responsivityFactor);

		// TODO: why does it need to be here?
		this.sendResponse(response);
	}

	private stepBackRequestFinalize(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, currentOutputLength:number): void {
		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT)
		{
			this._debuggerExecutableBusy = false;
			//this.sendResponse(response);
			return;
		}

		setTimeout(()=>this.stepBackRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		if (this._debuggerExecutableBusy)
		{
			setTimeout(()=>	this.evaluateRequest(response, args), this._responsivityFactor);
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this.process.stdin.write(`examine ${args.expression}\nprint '${BashDebugSession.BASHDB_PROMPT}'\n`);
		setTimeout(()=>this.evaluateRequestFinalize(response, args, currentLine), this._responsivityFactor);
	}

	private evaluateRequestFinalize(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, currentOutputLength:number): void {

		if (this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.BASHDB_PROMPT)
		{
			response.body = { result: `${args.expression} = '${this._fullDebugOutput[currentOutputLength - 1]}'`, variablesReference: 0	};

			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		setTimeout(()=>this.evaluateRequestFinalize(response, args, currentOutputLength), this._responsivityFactor);
	}
}

DebugSession.run(BashDebugSession);
