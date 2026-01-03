import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { Wallet, Subscription } from "./models";
import { fetchRecentActivity, getUsernameFromAddress } from "./polymarket";

const CHECK_INTERVAL = 10000; // 10 segundos

// Cache para evitar duplicação de mensagens
const sentMessages = new Map<string, number>();
const MESSAGE_CACHE_TTL = 120000; // 2 minutos

export async function startTrackerLoop(client: Client) {
  console.log(`🔥 TRACKER V4 INICIADO`);
  console.log(
    `🎯 Detecta: Novas posições, aumentos, diminuições e fechamentos`
  );
  console.log(`⏱️  Intervalo: ${CHECK_INTERVAL / 1000}s\n`);

  // Aguarda o bot estar pronto
  if (!client.isReady()) {
    console.log(`⏳ Aguardando bot ficar online...`);
    await new Promise((resolve) => {
      client.once("clientReady", resolve);
    });
    console.log(`✅ Bot online! Iniciando monitoramento...\n`);
  }

  setInterval(async () => {
    try {
      const timestamp = new Date().toLocaleTimeString("pt-BR");
      console.log(`\n💓 [${timestamp}] Verificando carteiras...`);

      // Limpa cache de mensagens antigas
      const now = Date.now();
      for (const [id, timestamp] of sentMessages.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          sentMessages.delete(id);
        }
      }

      const wallets = await Wallet.find();
      console.log(`📊 Total de carteiras monitoradas: ${wallets.length}`);

      if (wallets.length === 0) {
        console.log(`⚠️ Nenhuma carteira cadastrada`);
        return;
      }

      for (const wallet of wallets) {
        if (!wallet.address.startsWith("0x")) {
          console.warn(`⚠️ Endereço inválido: ${wallet.address}`);
          continue;
        }

        // Verifica se tem inscrições ativas
        const subs = await Subscription.find({ walletAddress: wallet.address });
        if (subs.length === 0) {
          console.log(
            `⚠️ Carteira ${wallet.address.slice(0, 8)} sem inscrições ativas`
          );
          continue;
        }

        console.log(
          `🔍 Checando ${wallet.address.slice(0, 8)}... (${
            subs.length
          } canal(is))`
        );

        // Busca mudanças no portfolio
        const activities = await fetchRecentActivity(wallet.address);

        if (activities.length === 0) {
          // Não loga mais nada aqui, o fetchRecentActivity já loga
          continue;
        }

        console.log(
          `🚨 MUDANÇA DETECTADA: ${activities.length} operação(ões)\n`
        );

        // Busca username uma vez
        const username = await getUsernameFromAddress(wallet.address);
        const displayName = username ? `@${username}` : null;

        // Atualiza timestamp
        await Wallet.updateOne(
          { _id: wallet._id },
          { lastTimestamp: Date.now() }
        );

        console.log(
          `   Slugs: event=${activities[0]?.eventSlug || "N/A"}, market=${
            activities[0]?.marketSlug || "N/A"
          }`
        );
        // Processa cada trade detectado
        for (const trade of activities) {
          // Verifica se já enviou
          if (sentMessages.has(trade.id)) {
            console.log(`   ⏭️ Pulando duplicata: ${trade.id.slice(0, 20)}...`);
            continue;
          }

          console.log(`\n   📤 Preparando mensagem...`);
          console.log(`      Tipo: ${trade.side}`);
          console.log(`      Mercado: ${trade.marketTitle.slice(0, 60)}`);
          console.log(`      Outcome: ${trade.outcome}`);
          console.log(`      Shares: ${trade.amount.toFixed(1)}`);
          console.log(`      Preço: ${trade.price.toFixed(3)}`);
          console.log(
            `      EventSlug: ${trade.eventSlug || "(sem eventSlug)"}`
          );
          console.log(
            `      MarketSlug: ${trade.marketSlug || "(sem marketSlug)"}`
          );

          // Detecção de tipo e cor
          let typeLabel = "OPERAÇÃO";
          let color = 0x808080;
          let emoji = "📊";

          const side = (trade.side || "").toUpperCase();

          if (side === "BUY") {
            typeLabel = "COMPROU";
            color = 0x00ff00;
            emoji = "🟢";
          } else if (side === "SELL") {
            typeLabel = "VENDEU";
            color = 0xff0000;
            emoji = "🔴";
          }

          // Cria URL do mercado
          let marketUrl = `https://polymarket.com/profile/${wallet.address}`;
          let marketTitle = trade.marketTitle;

          // Helper para validar slug (não hex, não vazio)
          const isValidSlug = (slug: string | undefined): boolean =>
            !!slug &&
            slug.length > 0 &&
            !slug.startsWith("0x") &&
            !/^[a-f0-9]{8,}$/i.test(slug);

          // Detecta se é um evento de esportes pelo padrão do slug
          const sportsPatterns: { [key: string]: string } = {
            nba: "nba",
            nfl: "nfl",
            nhl: "nhl",
            mlb: "mlb",
            ncaa: "ncaa",
            epl: "epl",
            ucl: "ucl",
            mls: "mls"
          };

          const detectSportsLeague = (slug: string): string | null => {
            const lower = slug.toLowerCase();
            for (const [prefix, league] of Object.entries(sportsPatterns)) {
              // Padrão: nba-team1-team2-YYYY-MM-DD
              if (
                lower.startsWith(`${prefix}-`) &&
                /\d{4}-\d{2}-\d{2}$/.test(lower)
              ) {
                return league;
              }
            }
            return null;
          };

          const hasValidEventSlug = isValidSlug(trade.eventSlug);
          const hasValidMarketSlug = isValidSlug(trade.marketSlug);

          if (hasValidEventSlug && hasValidMarketSlug) {
            // URL COMPLETA: /event/{eventSlug}/{marketSlug}?tid={tid}
            // Exemplo: /event/2026-fifa-world-cup-winner-595/will-algeria-win-the-2026-fifa-world-cup
            marketUrl = `https://polymarket.com/event/${trade.eventSlug}/${trade.marketSlug}`;

            if (trade.marketTid !== undefined && trade.marketTid !== null) {
              marketUrl += `?tid=${trade.marketTid}`;
            }

            marketTitle = `[${trade.marketTitle}](${marketUrl})`;
            console.log(`      Link: ${marketUrl}`);
          } else if (hasValidEventSlug) {
            // Só tem eventSlug - usa apenas ele
            marketUrl = `https://polymarket.com/event/${trade.eventSlug}`;

            if (trade.marketTid !== undefined && trade.marketTid !== null) {
              marketUrl += `?tid=${trade.marketTid}`;
            }

            marketTitle = `[${trade.marketTitle}](${marketUrl})`;
            console.log(`      Link: ${marketUrl}`);
          } else if (hasValidMarketSlug) {
            // Só tem marketSlug - tenta detectar se é esportes
            const sportsLeague = detectSportsLeague(trade.marketSlug);

            if (sportsLeague) {
              // URL de esportes: /sports/{league}/games/{slug}
              marketUrl = `https://polymarket.com/sports/${sportsLeague}/games/${trade.marketSlug}`;
              marketTitle = `[${trade.marketTitle}](${marketUrl})`;
              console.log(`      Link (sports): ${marketUrl}`);
            } else {
              // Último recurso: tenta /event/{marketSlug} (pode dar 404)
              marketUrl = `https://polymarket.com/event/${trade.marketSlug}`;
              if (trade.marketTid !== undefined && trade.marketTid !== null) {
                marketUrl += `?tid=${trade.marketTid}`;
              }
              marketTitle = `[${trade.marketTitle}](${marketUrl})`;
              console.log(
                `      Link (fallback - pode não funcionar): ${marketUrl}`
              );
            }
          } else {
            // Sem slug válido - não cria link
            marketTitle = trade.marketTitle;
            console.warn(
              `   ⚠️ Sem slug válido para ${trade.conditionId?.slice(
                0,
                8
              )}, link desabilitado`
            );
          }

          // Monta descrição
          let description = "";
          if (displayName) {
            description = `**Trader:** ${displayName}\n`;
          }

          // Usa o marketTitle que já tem o link (ou não)
          description += `**Mercado:** ${marketTitle}\n`;
          description += `**Posição:** ${trade.outcome}\n`;
          description += `**Carteira:** [\`${wallet.address}\`](https://polymarket.com/profile/${wallet.address})`;

          // Cria o embed
          const embed = new EmbedBuilder()
            .setTitle(`${emoji} ${typeLabel}`)
            .setURL(marketUrl)
            .setColor(color)
            .setDescription(description)
            .addFields(
              {
                name: "💵 Preço",
                value: `$${trade.price.toFixed(3)}`,
                inline: true
              },
              {
                name: "📊 Shares",
                value: `${trade.amount.toFixed(1)}`,
                inline: true
              },
              {
                name: "💰 Valor",
                value: `$${(trade.price * trade.amount).toFixed(2)}`,
                inline: true
              }
            )
            .setFooter({ text: `Developed by @chard_degen :)` })
            .setTimestamp(new Date(trade.timestamp));

          // Envia para todos os canais inscritos
          let sentCount = 0;
          for (const sub of subs) {
            try {
              const channel = client.channels.cache.get(
                sub.channelId
              ) as TextChannel;

              if (!channel) {
                console.error(
                  `   ❌ Canal ${sub.channelId} não encontrado no cache`
                );
                continue;
              }

              if (!channel.isTextBased()) {
                console.error(
                  `   ❌ Canal ${sub.channelId} não é baseado em texto`
                );
                continue;
              }

              await channel.send({ embeds: [embed] });
              sentCount++;
              console.log(`   ✓ Enviado para canal ${sub.channelId}`);
            } catch (e: any) {
              console.error(
                `   ❌ Erro ao enviar para ${sub.channelId}:`,
                e.message
              );
            }
          }

          if (sentCount > 0) {
            // Marca como enviado
            sentMessages.set(trade.id, Date.now());
            console.log(
              `   ✅ Mensagem enviada com sucesso para ${sentCount} canal(is)\n`
            );
          } else {
            console.log(`   ⚠️ Nenhum canal disponível para envio\n`);
          }

          // Delay entre mensagens
          await new Promise((r) => setTimeout(r, 500));
        }

        // Pausa entre carteiras
        await new Promise((r) => setTimeout(r, 1000));
      }

      console.log(`✓ Ciclo de verificação concluído\n`);
    } catch (e) {
      console.error("❌ Erro no Loop do Tracker:", e);
    }
  }, CHECK_INTERVAL);
}
