import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

export class GetStrategyParams extends createToolParameters(
  z.object({
    chainId: z.string().describe("The chain ID of the vault"),
    vaultAddress: z.string().describe("The address of the vault"),
  }),
) {}
