import { EchoChamberClientInterface } from "./client";

export const echoChambersPlugin = {
    name: "echochambers",
    description:
        "Plugin for interacting with EchoChambers API to enable multi-agent communication",
    actions: [], // No custom actions needed - core functionality handled by client
    evaluators: [], // No custom evaluators needed
    providers: [], // No custom providers needed
    clients: [EchoChamberClientInterface],
};

export default echoChambersPlugin;