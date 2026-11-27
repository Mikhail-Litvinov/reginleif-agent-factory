// A test that needs an environment variable names it when it is missing, instead of failing later on `undefined`
// ("path must be of type string ... received undefined"). `hint` says where the value comes from.
export const requiredEnv = (name: string, hint: string, env: NodeJS.ProcessEnv = process.env): string => {
	const value = env[name];
	if (value === undefined || value.trim() === "") throw new Error(`${name} is not set: ${hint}`);
	return value;
};
