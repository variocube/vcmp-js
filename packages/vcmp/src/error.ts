
export interface ProblemDetail {
	title: string;
	status: number;
	type?: string;
	instance?: string;
	detail?: string;
	[key: string]: any;
}

export function isProblemDetail(value: any): value is ProblemDetail {
	return typeof value === "object" && value !== null && "title" in value && "status" in value;
}

export class VcmpError extends Error implements ProblemDetail {
	constructor({title, status, type, instance, detail, ...props}: ProblemDetail) {
		super(detail);
		this.title = title;
		this.status = status;
		this.type = type;
		this.instance = instance;
		this.detail = detail;
		Object.assign(this, props);
	}

	title: string;
	status: number;
	type?: string;
	instance?: string;
	detail?: string;
	[key: string]: any;
}

export function createVcmpError(error: any) {
	if (error instanceof VcmpError) {
		return error;
	}
	if (isProblemDetail(error)) {
		return new VcmpError(error);
	}
	if (error instanceof Error) {
		return new VcmpError({
			title: error.name,
			status: 500,
			detail: error.message
		});
	}
	if (typeof error === "string") {
		return new VcmpError({
			title: "Error",
			status: 500,
			detail: error
		});
	}
	return new VcmpError({
		title: "Error",
		status: 500,
		detail: JSON.stringify(error)
	});
}
