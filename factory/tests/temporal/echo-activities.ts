export interface EchoActivities {
	Echo: (text: string) => Promise<string>;
}

export const echoActivities: EchoActivities = {
	Echo: async (text) => `echo:${text}`,
};
