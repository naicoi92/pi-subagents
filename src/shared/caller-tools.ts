export function isBoundedCallerTools(value: unknown): value is string[] {
	return Array.isArray(value)
		&& value.length <= 256
		&& value.every((tool) => typeof tool === "string" && !!tool.trim() && !tool.includes("\0") && Buffer.byteLength(tool) <= 1024)
		&& value.reduce((bytes, tool) => bytes + Buffer.byteLength(tool), 0) <= 65536;
}
