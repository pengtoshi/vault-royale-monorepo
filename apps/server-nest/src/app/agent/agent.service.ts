import { openai } from "@ai-sdk/openai";
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { viem } from "@goat-sdk/wallet-viem";
import { InjectRedis } from "@liaoliaots/nestjs-redis";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
// import { Cron, CronExpression } from "@nestjs/schedule";
import { generateText } from "ai";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ErrorMessage, VIEM_CHAINS } from "@libs/constants";
import type { CreateAgentInput, DepositAgentInput } from "@libs/model";
import { PrismaService } from "@libs/nestjs-core";
import type { Prisma } from "~/prisma/generated/client";
import { getExecutionPrompt } from "./prompt";
import { BlockchainService } from "../../common/blockchain/blockchain.service";
import { agentVaultPlugin } from "../../common/plugin/vault/agent-vault.plugin";
import { MarketService } from "../market/market.service";
import { TokenService } from "../token/token.service";

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectQueue("agent") private agentQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly marketService: MarketService,
    private readonly blockchainService: BlockchainService,
    private readonly tokenService: TokenService,
  ) {}

  async createAgent(createAgentInput: CreateAgentInput) {
    const { accountAddress, accountPrivateKey, ...agentInput } = createAgentInput;
    return this.prisma.$transaction(async (prismaTransaction: Prisma.TransactionClient) => {
      const tokenInfo = await this.tokenService.findTokenByAddress(createAgentInput.tokenAddress);
      if (!tokenInfo) {
        await this.tokenService.createTokenTx(
          createAgentInput.tokenAddress,
          createAgentInput.chainId,
          prismaTransaction,
        );
      }
      const agentInfo = await prismaTransaction.agent.create({
        data: {
          ...agentInput,
          address: accountAddress,
        },
      });
      await prismaTransaction.agentAccount.create({
        data: {
          address: accountAddress,
          privateKey: accountPrivateKey,
        },
      });
      return agentInfo;
    });
  }

  async depositAgent(depositAgentInput: DepositAgentInput) {
    const { agentId, depositAmount } = depositAgentInput;

    const agentInfo = await this.prisma.extended.agent.findUnique({
      where: { id: agentId },
    });
    if (!agentInfo) throw new Error(ErrorMessage.MSG_NOT_FOUND_AGENT);

    return this.prisma.agent.update({
      where: { id: agentId },
      data: {
        vaultDepositNumber: {
          increment: 1,
        },
        vaultDepositAmount: {
          increment: depositAmount,
        },
      },
    });
  }

  async getAgentOnChainTools(chainId: string, privateKey: string) {
    const rpcUrl = this.blockchainService.getRpcUrl(chainId);
    const walletClient = createWalletClient({
      account: privateKeyToAccount(privateKey as `0x${string}`),
      transport: http(rpcUrl),
      chain: VIEM_CHAINS[chainId],
    });

    const onChainTools = await getOnChainTools({
      wallet: viem(walletClient),
      plugins: [agentVaultPlugin()],
    });

    return onChainTools;
  }

  async executeAgent(agentId: string) {
    const agentInfo = await this.prisma.extended.agent.findUnique({
      where: { id: agentId },
    });
    if (!agentInfo) throw new Error(ErrorMessage.MSG_NOT_FOUND_AGENT);

    const agentAccountInfo = await this.prisma.agentAccount.findUnique({
      where: { address: agentInfo.address },
    });
    if (!agentAccountInfo) throw new Error(ErrorMessage.MSG_NOT_FOUND_AGENT_ACCOUNT);

    const { prompt: defaultPrompt, vaultAddress, chainId, riskLevel } = agentInfo;
    const { privateKey } = agentAccountInfo;

    const marketData = await this.marketService.getMockMarketData(chainId);
    const prompt = getExecutionPrompt(marketData, defaultPrompt, vaultAddress, chainId, riskLevel);
    const tools = await this.getAgentOnChainTools(chainId, privateKey);

    const result = await generateText({
      model: openai("gpt-4o-mini"),
      tools,
      maxSteps: 10,
      prompt,
      onStepFinish: (event) => {
        this.logger.log("Tool execution:", event.toolResults);
      },
    });

    await this.prisma.message.create({
      data: {
        agentId,
        content: result.text,
      },
    });
  }

  // TODO: Uncomment
  // @Cron(CronExpression.EVERY_30_MINUTES)
  async executeAllAgents() {
    const agents = await this.prisma.extended.agent.findMany();
    if (!agents || agents.length === 0) return false;

    await Promise.all(
      agents.map(async (agent) => {
        await this.agentQueue.add("executeAgent", { agentId: agent.id });
      }),
    );

    return true;
  }

  async findAgentById(agentId: string) {
    return this.prisma.extended.agent.findUnique({ where: { id: agentId } });
  }

  async findAllAgents() {
    return this.prisma.extended.agent.findMany();
  }

  async resolveMessages(agentId: string) {
    if (!agentId) throw new Error(ErrorMessage.MSG_NOT_FOUND_AGENT);
    return this.prisma.extended.message.findMany({ where: { agentId } });
  }

  async resolveChain(chainId: string) {
    if (!chainId) throw new Error(ErrorMessage.MSG_NOT_FOUND_CHAIN);
    return this.prisma.extended.chain.findUnique({ where: { chainId } });
  }
}
