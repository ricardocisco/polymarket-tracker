import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  type Interaction
} from "discord.js";
import { Wallet, Subscription } from "./models";
import {
  fetchPortfolio,
  resolveUser,
  testAPIConnection,
  clearCache,
  getUsernameFromAddress
} from "./polymarket";

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const rawInput =
    interaction.options.getString("input") ||
    interaction.options.getString("carteira");

  // ===== COMANDO /TRACK =====
  if (interaction.commandName === "track") {
    await interaction.deferReply();

    if (!rawInput) {
      await interaction.editReply(
        "❌ Você precisa fornecer um endereço ou @username."
      );
      return;
    }

    console.log(`🔍 Tentando rastrear: ${rawInput}`);

    // Resolve o endereço 0x
    const address = await resolveUser(rawInput);

    if (!address) {
      await interaction.editReply(
        `❌ Não consegui encontrar o endereço para **${rawInput}**.\n` +
          `Certifique-se de que:\n` +
          `• O username está correto (ex: @nickname)\n` +
          `• Ou use o endereço 0x completo da carteira`
      );
      return;
    }

    try {
      // Busca ou cria a carteira
      let wallet = await Wallet.findOne({ address });

      if (!wallet) {
        console.log(`🆕 Nova carteira: ${address}`);

        // IMPORTANTE: Define lastTimestamp como AGORA para só pegar trades FUTUROS
        wallet = await Wallet.create({
          address,
          lastTimestamp: Date.now()
        });

        console.log(
          `   └─ Criada com timestamp: ${new Date(
            wallet.lastTimestamp
          ).toISOString()}`
        );
      } else {
        console.log(`♻️ Carteira já existe: ${address}`);
      }

      // Verifica se este canal já rastreia essa carteira
      const existingSub = await Subscription.findOne({
        channelId: interaction.channelId,
        walletAddress: address
      });

      if (existingSub) {
        await interaction.editReply(
          `⚠️ Este canal já está rastreando a carteira:\n` +
            `[\`${address.slice(0, 6)}...${address.slice(
              -4
            )}\`](https://polymarket.com/profile/${address})`
        );
        return;
      }

      // Cria a inscrição
      await Subscription.create({
        channelId: interaction.channelId,
        walletAddress: address
      });

      console.log(
        `✅ Inscrição criada: Canal ${interaction.channelId} → ${address.slice(
          0,
          8
        )}`
      );

      await interaction.editReply(
        `✅ **Rastreamento Ativado!**\n\n` +
          `📡 **Carteira:** [\`${address.slice(0, 6)}...${address.slice(
            -4
          )}\`](https://polymarket.com/profile/${address})\n` +
          `⏰ Você receberá alertas de **mudanças no portfolio** (novas posições, aumentos, vendas).\n\n` +
          `💡 **Como funciona:** O bot compara o portfolio a cada 30s e detecta:\n` +
          `  • 🆕 Novas posições abertas\n` +
          `  • 📈 Aumentos em posições existentes\n` +
          `  • 📉 Reduções/vendas parciais\n` +
          `  • 🔴 Fechamento de posições\n\n` +
          `📊 Use \`/portfolio ${rawInput}\` para ver as posições atuais.`
      );
    } catch (error: any) {
      console.error("❌ Erro ao criar tracking:", error);
      await interaction.editReply(
        `❌ Erro interno ao salvar no banco de dados.\n` +
          `Detalhes: ${error.message}`
      );
    }
  }

  // ===== COMANDO /UNTRACK =====
  if (interaction.commandName === "untrack") {
    await interaction.deferReply();

    if (!rawInput) {
      await interaction.editReply(
        "❌ Você precisa fornecer o endereço ou @username para desrastrear."
      );
      return;
    }

    const address = await resolveUser(rawInput);

    if (!address) {
      await interaction.editReply(
        `❌ Não encontrei essa carteira. Use o mesmo formato usado no \`/track\`.`
      );
      return;
    }

    try {
      // Remove a inscrição DESTE canal
      const deletedSub = await Subscription.findOneAndDelete({
        channelId: interaction.channelId,
        walletAddress: address
      });

      if (!deletedSub) {
        await interaction.editReply(
          `⚠️ Este canal não estava rastreando:\n` + `\`${address}\``
        );
        return;
      }

      // Garbage Collection: Remove carteira se não tem mais inscritos
      const remainingSubs = await Subscription.countDocuments({
        walletAddress: address
      });

      if (remainingSubs === 0) {
        await Wallet.findOneAndDelete({ address });
        console.log(
          `🗑️ Carteira ${address.slice(0, 8)} removida (0 inscritos)`
        );
      }

      await interaction.editReply(
        `✅ **Rastreamento Removido!**\n\n` +
          `Este canal não receberá mais alertas de:\n` +
          `\`${address.slice(0, 6)}...${address.slice(-4)}\``
      );
    } catch (error: any) {
      console.error("❌ Erro ao remover:", error);
      await interaction.editReply(`❌ Erro: ${error.message}`);
    }
  }

  // ===== COMANDO /PORTFOLIO =====
  if (interaction.commandName === "portfolio") {
    await interaction.deferReply();

    if (!rawInput) {
      await interaction.editReply(
        "❌ Você precisa fornecer um endereço ou @username."
      );
      return;
    }

    console.log(`📊 Buscando portfolio de: ${rawInput}`);

    const address = await resolveUser(rawInput);

    if (!address) {
      await interaction.editReply(
        "❌ Não consegui encontrar esse usuário ou endereço."
      );
      return;
    }

    // Busca posições
    const positions = await fetchPortfolio(address);

    if (!positions || positions.length === 0) {
      await interaction.editReply(
        `ℹ️ **Nenhuma posição ativa encontrada**\n\n` +
          `Carteira: [\`${address.slice(0, 6)}...${address.slice(
            -4
          )}\`](https://polymarket.com/profile/${address})\n\n` +
          `O trader pode não ter posições abertas no momento.`
      );
      return;
    }

    // Calcula totais
    const totalPnl = positions.reduce((acc, p) => acc + p.pnl, 0);
    const totalValue = positions.reduce((acc, p) => acc + p.currentValue, 0);
    const totalInvested = positions.reduce(
      (acc, p) => acc + p.size * p.entryPrice,
      0
    );

    const pnlEmoji = totalPnl >= 0 ? "📈" : "📉";
    const pnlColor = totalPnl >= 0 ? 0x00ff00 : 0xff0000;

    const embed = new EmbedBuilder()
      .setTitle(`💼 Portfolio`)
      .setURL(`https://polymarket.com/profile/${address}`)
      .setDescription(
        `**Carteira:** [\`${address.slice(0, 6)}...${address.slice(
          -4
        )}\`](https://polymarket.com/profile/${address})\n` +
          `**Posições Ativas:** ${positions.length}`
      )
      .setColor(pnlColor)
      .addFields(
        {
          name: "💵 Valor Atual",
          value: `$${totalValue.toFixed(2)}`,
          inline: true
        },
        {
          name: "💰 Investido",
          value: `$${totalInvested.toFixed(2)}`,
          inline: true
        },
        {
          name: `${pnlEmoji} P&L Total`,
          value: `**$${totalPnl.toFixed(2)}**\n(${totalPnl >= 0 ? "+" : ""}${(
            (totalPnl / totalInvested) *
            100
          ).toFixed(1)}%)`,
          inline: true
        }
      );

    // Adiciona até 10 maiores posições
    const topPositions = positions.slice(0, 10);

    for (const pos of topPositions) {
      const pnlIcon = pos.pnl >= 0 ? "🟢" : "🔴";
      const pnlSign = pos.pnl >= 0 ? "+" : "";

      embed.addFields({
        name: `${pnlIcon} ${pos.title.slice(0, 60)}${
          pos.title.length > 60 ? "..." : ""
        }`,
        value:
          `**${pos.outcome}** • Atual: $${pos.currentPrice.toFixed(3)} | ` +
          `Entry: $${pos.entryPrice.toFixed(3)}\n` +
          `P&L: ${pnlSign}$${pos.pnl.toFixed(
            2
          )} (${pnlSign}${pos.pnlPercent.toFixed(1)}%) • ` +
          `Size: ${pos.size.toFixed(0)} shares`,
        inline: false
      });
    }

    if (positions.length > 10) {
      embed.setFooter({
        text: `Mostrando 10 de ${positions.length} posições • Use o link para ver todas`
      });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  // ===== COMANDO /DEBUG (TESTE DE APIS) =====
  if (interaction.commandName === "debug") {
    await interaction.deferReply();

    if (!rawInput) {
      await interaction.editReply(
        "❌ Você precisa fornecer um endereço para testar."
      );
      return;
    }

    const address = await resolveUser(rawInput);

    if (!address) {
      await interaction.editReply("❌ Endereço inválido.");
      return;
    }

    await interaction.editReply(
      `🧪 **Testando APIs da Polymarket...**\n\n` +
        `Endereço: \`${address}\`\n\n` +
        `Aguarde, isso pode levar alguns segundos...`
    );

    // Executa teste no console
    await testAPIConnection(address);

    // Busca uma posição de exemplo para debug
    try {
      const positions = await fetchPortfolio(address);
      if (positions.length > 0) {
        const sample = positions[0];
        await interaction.editReply(
          `✅ **Teste Concluído!**\n\n` +
            `Verifique o console do servidor para ver os resultados detalhados.\n\n` +
            `**Exemplo de posição encontrada:**\n` +
            `• Mercado: ${sample.title}\n` +
            `• Outcome: ${sample.outcome}\n` +
            `• Size: ${sample.size.toFixed(1)} shares\n` +
            `• Asset ID: \`${sample.assetId}\``
        );
      } else {
        await interaction.editReply(
          `✅ **Teste Concluído!**\n\n` +
            `Verifique o console. Nenhuma posição ativa encontrada.`
        );
      }
    } catch (e: any) {
      await interaction.editReply(
        `⚠️ **Teste parcial concluído**\n\n` +
          `Erro: ${e.message}\n\n` +
          `Verifique o console para mais detalhes.`
      );
    }
  }

  // ===== COMANDO /LIST =====
  if (interaction.commandName === "list") {
    await interaction.deferReply();

    try {
      const subs = await Subscription.find({
        channelId: interaction.channelId
      });

      if (subs.length === 0) {
        await interaction.editReply(
          `ℹ️ **Nenhuma carteira rastreada neste canal.**\n\n` +
            `Use \`/track <endereço>\` para começar a rastrear.`
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`📋 Carteiras Rastreadas`)
        .setDescription(
          `Este canal está rastreando **${subs.length}** carteira(s):`
        )
        .setColor(0x5865f2);

      for (const sub of subs) {
        const wallet = await Wallet.findOne({ address: sub.walletAddress });
        const username = wallet
          ? await getUsernameFromAddress(wallet.address)
          : null;
        const displayName = username ? `@${username}` : null;
        let description = "";
        if (displayName) {
          description = `User: ${displayName}\n`;
        }
        description += `Carteira: ${sub.walletAddress}`;
        const lastCheck = wallet?.lastTimestamp
          ? new Date(wallet.lastTimestamp).toLocaleString("pt-BR")
          : "Nunca";

        embed.addFields({
          name: `${description}`,
          value: `[Ver perfil](https://polymarket.com/profile/${sub.walletAddress}) • Última checagem: ${lastCheck}`,
          inline: false
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error: any) {
      console.error("Erro ao listar:", error);
      await interaction.editReply(`❌ Erro: ${error.message}`);
    }
  }

  // ===== COMANDO /HELP =====
  if (interaction.commandName === "help") {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle("🤖 Polymarket Tracker - Ajuda")
      .setDescription(
        `Bot para rastrear apostas em tempo real na Polymarket.\n\n` +
          `**Como funciona:**\n` +
          `O bot monitora carteiras e envia alertas quando novas apostas são feitas.`
      )
      .setColor(0x5865f2)
      .addFields(
        {
          name: "📡 `/track <endereço>`",
          value:
            "Começa a rastrear uma carteira. Você receberá alertas de novas apostas.\n" +
            "Aceita: `0x123...abc` ou `@username`",
          inline: false
        },
        {
          name: "🚫 `/untrack <endereço>`",
          value: "Para de rastrear uma carteira neste canal.",
          inline: false
        },
        {
          name: "💼 `/portfolio <endereço>`",
          value: "Mostra todas as posições ativas e P&L total de uma carteira.",
          inline: false
        },
        {
          name: "📋 `/list`",
          value: "Lista todas as carteiras rastreadas neste canal.",
          inline: false
        },
        {
          name: "🧪 `/debug <endereço>`",
          value:
            "Testa a conectividade com as APIs (útil se algo não estiver funcionando).",
          inline: false
        }
      )
      .setFooter({
        text: "💡 Dica: Use @username para facilitar (ex: @GCR)"
      });

    await interaction.editReply({ embeds: [embed] });
  }
});
