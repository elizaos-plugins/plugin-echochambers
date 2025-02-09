import { elizaLogger, type Client, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { EchoChamberClient } from "./echoChamberClient";
import { InteractionClient } from "./interactions";
import type { EchoChamberConfig } from "./types";
import { validateEchoChamberConfig } from "./environment";

export const EchoChamberClientInterface: Client = {
    name: "echochamber",
    async start(runtime: IAgentRuntime) {
        try {
            // Validate configuration before starting
            await validateEchoChamberConfig(runtime);

            const apiUrl = runtime.getSetting("ECHOCHAMBERS_API_URL");
            const apiKey = runtime.getSetting("ECHOCHAMBERS_API_KEY");

            if (!apiKey || !apiUrl) {
                throw new Error(
                    "ECHOCHAMBERS_API_KEY/ECHOCHAMBERS_API_URL is required"
                );
            }

            const config: EchoChamberConfig = {
                apiUrl,
                apiKey,
                username:
                    runtime.getSetting("ECHOCHAMBERS_USERNAME") ||
                    `agent-${runtime.agentId}`,
                model: runtime.modelProvider,
                rooms: runtime
                    .getSetting("ECHOCHAMBERS_ROOMS")
                    ?.split(",")
                    .map((r) => r.trim()) || ["general"],
            };

            elizaLogger.log("Starting EchoChambers client...");

            // Initialize the API client
            const client = new EchoChamberClient(runtime, config);
            await client.start();

            // Initialize the interaction handler
            const interactionClient = new InteractionClient(client, runtime);
            await interactionClient.start();

            elizaLogger.success(
                `✅ EchoChambers client successfully started for character ${runtime.character.name}`
            );

            return {
                client,
                interactionClient,
                async stop(runtime: IAgentRuntime) {
                    try {
                        elizaLogger.warn("Stopping EchoChambers client...");
            
                        // Get client instances if they exist
                        const clients = (runtime as any).clients?.filter(
                            (c: any) =>
                                c instanceof EchoChamberClient ||
                                c instanceof InteractionClient
                        );
            
                        for (const client of clients) {
                            await client.stop();
                        }
            
                        elizaLogger.success("EchoChambers client stopped successfully");
                    } catch (error) {
                        elizaLogger.error("Error stopping EchoChambers client:", error);
                        throw error;
                    }
                },
            };
        } catch (error) {
            elizaLogger.error("Failed to start EchoChambers client:", error);
            throw error;
        }
    },
};