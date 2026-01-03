import axios from "axios";

const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://polymarket.com",
  Referer: "https://polymarket.com/",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};

export interface PolyActivity {
  id: string;
  timestamp: number;
  type: string;
  marketTitle: string;
  outcome: string;
  side: string;
  price: number;
  amount: number;
  eventSlug: string; // Slug do evento pai (ex: 2026-nba-champion)
  marketSlug: string; // Slug do sub-mercado (ex: will-the-toronto-raptors-win...)
  conditionId?: string;
  assetId?: string;
  marketTid?: number | string; // Para linkar outcome correto
}

export interface PolyPosition {
  title: string;
  outcome: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  currentValue: number;
  eventSlug: string; // Slug do evento pai
  marketSlug: string; // Slug do sub-mercado
  assetId: string;
  conditionId: string;
}

// Cache de usernames
const usernameCache = new Map<
  string,
  { username: string; timestamp: number }
>();
const USERNAME_CACHE_TTL = 3600000;

// Cache de portfolio com timestamp
const portfolioSnapshots = new Map<
  string,
  { positions: Map<string, PolyPosition>; timestamp: number }
>();

// NOVO: Cache de informações de mercados
// Agora guarda eventSlug e marketSlug separados
const marketInfoCache = new Map<
  string,
  {
    eventSlug: string;
    marketSlug: string;
    title: string;
    timestamp: number;
  }
>();
const MARKET_CACHE_TTL = 86400000; // 24 horas

// Cache de metadados do CLOB (outcomes <-> clobTokenIds)
const clobMetaCache = new Map<
  string,
  {
    outcomes: string[];
    clobTokenIds: Array<string | number>;
    timestamp: number;
  }
>();
const CLOB_META_CACHE_TTL = 86400000; // 24 horas

// NOVA FUNÇÃO: Busca informações detalhadas do mercado
// Retorna eventSlug e marketSlug separados para montar URL correta
async function getMarketInfo(
  conditionId: string,
  assetId?: string
): Promise<{
  eventSlug: string;
  marketSlug: string;
  title: string;
} | null> {
  // Verifica cache
  const cached = marketInfoCache.get(conditionId);
  if (cached && Date.now() - cached.timestamp < MARKET_CACHE_TTL) {
    return {
      eventSlug: cached.eventSlug,
      marketSlug: cached.marketSlug,
      title: cached.title
    };
  }

  let foundTitle = "";
  let foundEventSlug = "";
  let foundMarketSlug = "";

  // Tenta múltiplas estratégias
  try {
    // ESTRATÉGIA 1: Busca direta via conditionId no DATA API
    try {
      const directResponse = await axios.get(
        `${DATA_API_URL}/markets/${conditionId}`,
        {
          headers: BROWSER_HEADERS,
          timeout: 5000,
          validateStatus: (status) => status < 500
        }
      );

      if (directResponse.status === 200 && directResponse.data) {
        const d = directResponse.data;
        const title = d.question || d.title || "";
        // marketSlug é o slug do sub-mercado (limpa possíveis IDs numéricos)
        let marketSlug = d.slug || d.market_slug || "";
        // eventSlug é o slug do evento pai - tenta vários campos possíveis
        const eventSlug =
          d.groupItemSlug ||
          d.eventSlug ||
          d.event_slug ||
          d.parentSlug ||
          d.groupSlug ||
          (d.event && d.event.slug) ||
          (d.group && d.group.slug) ||
          "";

        if (title && !foundTitle) foundTitle = title;
        if (eventSlug && !foundEventSlug) foundEventSlug = eventSlug;
        if (marketSlug && !foundMarketSlug) foundMarketSlug = marketSlug;

        // DEBUG: Log para ver o que a API retorna
        if (!eventSlug) {
          console.log(
            `   🔍 DATA API campos disponíveis: ${Object.keys(d).join(", ")}`
          );
        }

        if (foundTitle && (foundEventSlug || foundMarketSlug)) {
          marketInfoCache.set(conditionId, {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle,
            timestamp: Date.now()
          });
          return {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle
          };
        }
      }
    } catch (e) {
      // Continua para próxima estratégia
    }

    // ESTRATÉGIA 2: Busca via CLOB markets
    try {
      const clobResponse = await axios.get(
        `${CLOB_API_URL}/markets/${conditionId}`,
        {
          headers: BROWSER_HEADERS,
          timeout: 3000,
          validateStatus: (status) => status < 500
        }
      );

      if (clobResponse.status === 200 && clobResponse.data) {
        const d = clobResponse.data;
        const title = d.question || d.description || "";
        const marketSlug = d.slug || d.market_slug || "";
        const eventSlug =
          d.groupItemSlug ||
          d.eventSlug ||
          d.event_slug ||
          d.parentSlug ||
          d.groupSlug ||
          (d.event && d.event.slug) ||
          (d.group && d.group.slug) ||
          "";

        if (title && !foundTitle) foundTitle = title;
        if (eventSlug && !foundEventSlug) foundEventSlug = eventSlug;
        if (marketSlug && !foundMarketSlug) foundMarketSlug = marketSlug;

        if (foundTitle && (foundEventSlug || foundMarketSlug)) {
          marketInfoCache.set(conditionId, {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle,
            timestamp: Date.now()
          });
          return {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle
          };
        }
      }
    } catch (e) {
      // Continua
    }

    // ESTRATÉGIA 3: Busca via Gamma por condition_id (com busca de evento)
    try {
      const gammaResponse = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_id: conditionId },
        headers: BROWSER_HEADERS,
        timeout: 5000,
        validateStatus: (status) => status < 500
      });

      if (
        gammaResponse.data &&
        Array.isArray(gammaResponse.data) &&
        gammaResponse.data[0]
      ) {
        const market = gammaResponse.data[0];
        const title = market.question || market.title || "";
        const marketSlug = market.slug || market.market_slug || "";

        // Captura o ID do evento para buscar o eventSlug
        const eventId =
          market.event_id || market.eventId || market.group_id || "";

        // Tenta múltiplos campos para eventSlug
        let eventSlug =
          market.groupItemSlug ||
          market.eventSlug ||
          market.event_slug ||
          market.parentSlug ||
          market.groupSlug ||
          (market.events && market.events[0] && market.events[0].slug) ||
          (market.event && market.event.slug) ||
          "";

        // Se não encontrou eventSlug mas tem eventId, busca o evento
        if (!eventSlug && eventId) {
          try {
            const eventResponse = await axios.get(
              `${GAMMA_API_URL}/events/${eventId}`,
              {
                headers: BROWSER_HEADERS,
                timeout: 3000,
                validateStatus: (status) => status < 500
              }
            );

            if (eventResponse.status === 200 && eventResponse.data) {
              eventSlug = eventResponse.data.slug || "";
              console.log(`   🎯 Evento encontrado via ID: ${eventSlug}`);
            }
          } catch (e) {
            // Tenta busca alternativa por slug
          }
        }

        // Se ainda não tem eventSlug, tenta buscar evento pelo slug do mercado
        if (!eventSlug && marketSlug) {
          try {
            const eventsResponse = await axios.get(`${GAMMA_API_URL}/events`, {
              params: { slug: marketSlug, limit: 1 },
              headers: BROWSER_HEADERS,
              timeout: 3000,
              validateStatus: (status) => status < 500
            });

            if (
              eventsResponse.data &&
              Array.isArray(eventsResponse.data) &&
              eventsResponse.data[0]
            ) {
              eventSlug = eventsResponse.data[0].slug || "";
              console.log(`   🎯 Evento encontrado via busca: ${eventSlug}`);
            }
          } catch (e) {
            // Continua
          }
        }

        if (title && !foundTitle) foundTitle = title;
        if (eventSlug && !foundEventSlug) foundEventSlug = eventSlug;
        if (marketSlug && !foundMarketSlug) foundMarketSlug = marketSlug;

        // DEBUG: Se não encontrou eventSlug, mostra campos disponíveis
        if (!eventSlug && !foundEventSlug) {
          console.log(
            `   🔍 Gamma market campos: ${Object.keys(market).join(", ")}`
          );
          if (eventId) console.log(`   📌 Event ID: ${eventId}`);
        }

        if (foundTitle && (foundEventSlug || foundMarketSlug)) {
          marketInfoCache.set(conditionId, {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle,
            timestamp: Date.now()
          });
          return {
            eventSlug: foundEventSlug,
            marketSlug: foundMarketSlug,
            title: foundTitle
          };
        }
      }
    } catch (e) {
      // Continua
    }

    // ESTRATÉGIA 4: Busca via Gamma usando clob_token_ids (assetId)
    if (assetId) {
      try {
        const gammaTokenResponse = await axios.get(`${GAMMA_API_URL}/markets`, {
          params: { clob_token_ids: assetId },
          headers: BROWSER_HEADERS,
          timeout: 3000,
          validateStatus: (status) => status < 500
        });

        if (
          gammaTokenResponse.data &&
          Array.isArray(gammaTokenResponse.data) &&
          gammaTokenResponse.data[0]
        ) {
          const market = gammaTokenResponse.data[0];
          const title = market.question || market.title || "";
          const marketSlug = market.slug || market.market_slug || "";
          const eventSlug =
            market.groupItemSlug ||
            market.eventSlug ||
            market.event_slug ||
            market.parentSlug ||
            market.groupSlug ||
            (market.events && market.events[0] && market.events[0].slug) ||
            (market.event && market.event.slug) ||
            "";

          if (title && !foundTitle) foundTitle = title;
          if (eventSlug && !foundEventSlug) foundEventSlug = eventSlug;
          if (marketSlug && !foundMarketSlug) foundMarketSlug = marketSlug;
        }
      } catch (e) {
        // Continua
      }
    }

    // ESTRATÉGIA 5: Se temos marketSlug mas não eventSlug, usa marketSlug como eventSlug
    // Alguns mercados simples (não multi-outcome) têm o mesmo slug para ambos
    if (foundTitle && !foundEventSlug && foundMarketSlug) {
      // Verifica se o marketSlug parece válido (não tem números longos)
      const cleanSlug = foundMarketSlug
        .replace(/-\d{3,}/g, "")
        .replace(/-+$/, "");
      if (cleanSlug.length > 5 && !cleanSlug.match(/^\d+$/)) {
        foundEventSlug = cleanSlug;
        console.log(
          `   📝 Usando marketSlug limpo como eventSlug: ${cleanSlug}`
        );
      }
    }

    // Log se ainda não encontrou
    if (foundTitle && !foundEventSlug) {
      console.log(`   ⚠️ Sem eventSlug da API para ${conditionId.slice(0, 8)}`);
    }

    // Salva o que encontrou (mesmo que parcial)
    if (foundTitle) {
      marketInfoCache.set(conditionId, {
        eventSlug: foundEventSlug,
        marketSlug: foundMarketSlug,
        title: foundTitle,
        timestamp: Date.now()
      });
      return {
        eventSlug: foundEventSlug,
        marketSlug: foundMarketSlug,
        title: foundTitle
      };
    }

    console.warn(
      `⚠️ Todas estratégias falharam para ${conditionId.slice(0, 8)}`
    );
    return null;
  } catch (error: any) {
    console.warn(
      `⚠️ Erro geral ao buscar ${conditionId.slice(0, 8)}:`,
      error.message
    );
    return null;
  }
}

// 1. RESOLVER USUÁRIO
export async function resolveUser(input: string): Promise<string | null> {
  const cleanInput = input.trim();

  if (/^0x[a-fA-F0-9]{40}$/i.test(cleanInput)) {
    return cleanInput.toLowerCase();
  }

  let slug = cleanInput
    .replace("https://polymarket.com/@", "")
    .replace("https://polymarket.com/profile/", "")
    .replace("@", "")
    .split("?")[0];

  try {
    const profileUrl = `https://polymarket.com/@${slug}`;
    const { data: html } = await axios.get(profileUrl, {
      headers: BROWSER_HEADERS,
      timeout: 8000
    });

    const patterns = [
      /"proxyWallet":"(0x[a-fA-F0-9]{40})"/i,
      /"address":"(0x[a-fA-F0-9]{40})"/i,
      /wallet["|']:\s*["|'](0x[a-fA-F0-9]{40})["|']/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        console.log(`✅ Resolvido @${slug} → ${match[1]}`);
        return match[1].toLowerCase();
      }
    }

    console.warn(`⚠️ Não encontrei endereço para @${slug}`);
    return null;
  } catch (error: any) {
    console.error(`❌ Erro ao resolver @${slug}:`, error.message);
    return null;
  }
}

// Helper: obtém um preço de "execução provável" para o ativo
// SELL → usa bid; BUY → usa ask; fallback para mid
async function getQuotePrice(
  assetId: string,
  side: "BUY" | "SELL"
): Promise<number> {
  const sidePref = side === "SELL" ? "bid" : "ask";

  // 1) Tenta bid/ask
  try {
    const res = await axios.get(`${CLOB_API_URL}/price`, {
      params: { token_id: assetId, side: sidePref },
      headers: BROWSER_HEADERS,
      timeout: 2000,
      validateStatus: (status) => status < 500
    });
    const px = Number(res.data?.price || 0);
    if (px > 0) return px;
  } catch {}

  // 2) Fallback para mid
  try {
    const res = await axios.get(`${CLOB_API_URL}/price`, {
      params: { token_id: assetId, side: "mid" },
      headers: BROWSER_HEADERS,
      timeout: 2000,
      validateStatus: (status) => status < 500
    });
    const px = Number(res.data?.price || 0);
    if (px > 0) return px;
  } catch {}

  return 0;
}

// Helper: obtém outcomes e clobTokenIds do mercado (CLOB) para montar tid
async function getClobMeta(conditionId: string): Promise<{
  outcomes: string[];
  clobTokenIds: Array<string | number>;
} | null> {
  const cached = clobMetaCache.get(conditionId);
  if (cached && Date.now() - cached.timestamp < CLOB_META_CACHE_TTL) {
    return {
      outcomes: cached.outcomes,
      clobTokenIds: cached.clobTokenIds
    };
  }

  try {
    const resp = await axios.get(`${CLOB_API_URL}/markets/${conditionId}`, {
      headers: BROWSER_HEADERS,
      timeout: 4000,
      validateStatus: (status) => status < 500
    });

    if (resp.status !== 200 || !resp.data) return null;

    const outcomes: string[] =
      (Array.isArray(resp.data.outcomes) ? resp.data.outcomes : []) || [];
    const clobTokenIds: Array<string | number> =
      (Array.isArray(resp.data.clobTokenIds) ? resp.data.clobTokenIds : []) ||
      [];

    if (outcomes.length === 0 && clobTokenIds.length === 0) return null;

    clobMetaCache.set(conditionId, {
      outcomes,
      clobTokenIds,
      timestamp: Date.now()
    });

    return { outcomes, clobTokenIds };
  } catch {
    return null;
  }
}

// 2. BUSCAR ATIVIDADE (Monitora mudanças no portfolio)
export async function fetchRecentActivity(
  address: string
): Promise<PolyActivity[]> {
  try {
    const currentPositions = await fetchPortfolioRaw(address);

    if (currentPositions.length === 0) {
      console.log(`   ℹ️ Portfolio vazio`);
      return [];
    }

    // Cria Map com as posições atuais
    // IMPORTANTE: A chave DEVE incluir o conditionId para diferenciar mercados
    const currentMap = new Map<string, PolyPosition>();
    currentPositions.forEach((pos) => {
      const key = `${pos.conditionId}-${pos.outcome}-${pos.assetId}`;
      currentMap.set(key, pos);
    });

    // Busca snapshot anterior
    const snapshot = portfolioSnapshots.get(address);

    if (!snapshot) {
      console.log(
        `📸 Snapshot inicial salvo (${currentPositions.length} posições)`
      );

      portfolioSnapshots.set(address, {
        positions: currentMap,
        timestamp: Date.now()
      });
      return [];
    }

    // Compara com snapshot anterior
    const activities: PolyActivity[] = [];
    const previousMap = snapshot.positions;

    // 1. DETECTA NOVAS POSIÇÕES
    for (const [key, current] of currentMap.entries()) {
      if (!previousMap.has(key)) {
        activities.push({
          id: `${key}-new-${Date.now()}`,
          timestamp: Date.now(),
          type: "Trade",
          marketTitle: current.title,
          outcome: current.outcome,
          side: "BUY",
          price: current.entryPrice,
          amount: current.size,
          eventSlug: current.eventSlug,
          marketSlug: current.marketSlug,
          conditionId: current.conditionId,
          assetId: current.assetId
        });
        console.log(
          `   🆕 Nova: ${current.title.slice(0, 40)} - ${
            current.outcome
          } | CondId: ${current.conditionId.slice(
            0,
            8
          )} (${current.size.toFixed(1)} shares)`
        );
      }
    }

    // 2. DETECTA AUMENTOS/DIMINUIÇÕES
    for (const [key, current] of currentMap.entries()) {
      const previous = previousMap.get(key);

      if (previous) {
        const sizeDiff = current.size - previous.size;

        if (sizeDiff > 0.5) {
          const prevInvested = previous.size * previous.entryPrice;
          const currInvested = current.size * current.entryPrice;
          const investmentDiff = currInvested - prevInvested;
          const avgPrice = investmentDiff / sizeDiff;

          activities.push({
            id: `${key}-increase-${Date.now()}`,
            timestamp: Date.now(),
            type: "Trade",
            marketTitle: current.title,
            outcome: current.outcome,
            side: "BUY",
            price: avgPrice > 0 ? avgPrice : current.currentPrice,
            amount: sizeDiff,
            eventSlug: current.eventSlug,
            marketSlug: current.marketSlug,
            conditionId: current.conditionId,
            assetId: current.assetId
          });
          console.log(
            `   📈 Aumentou: ${current.title.slice(0, 40)} - ${
              current.outcome
            } | CondId: ${current.conditionId.slice(0, 8)} +${sizeDiff.toFixed(
              1
            )} shares @ ${avgPrice.toFixed(3)}`
          );
        } else if (sizeDiff < -0.5) {
          // Para venda, tenta usar o bid atual como proxy do preço de execução
          let sellPrice = current.currentPrice;
          if (current.assetId) {
            const px = await getQuotePrice(current.assetId, "SELL");
            if (px > 0) sellPrice = px;
          }

          activities.push({
            id: `${key}-decrease-${Date.now()}`,
            timestamp: Date.now(),
            type: "Trade",
            marketTitle: current.title,
            outcome: current.outcome,
            side: "SELL",
            price: sellPrice,
            amount: Math.abs(sizeDiff),
            eventSlug: current.eventSlug,
            marketSlug: current.marketSlug,
            conditionId: current.conditionId,
            assetId: current.assetId
          });
          console.log(
            `   📉 Vendeu: ${current.title.slice(0, 40)} - ${
              current.outcome
            } | CondId: ${current.conditionId.slice(0, 8)} ${sizeDiff.toFixed(
              1
            )} shares @ ${sellPrice.toFixed(3)}`
          );
        }
      }
    }

    // 3. DETECTA POSIÇÕES FECHADAS
    for (const [key, previous] of previousMap.entries()) {
      if (!currentMap.has(key)) {
        // Usa bid como proxy do preço de execução no fechamento
        let closePrice = previous.currentPrice;
        if (previous.assetId) {
          const px = await getQuotePrice(previous.assetId, "SELL");
          if (px > 0) closePrice = px;
        }

        activities.push({
          id: `${key}-close-${Date.now()}`,
          timestamp: Date.now(),
          type: "Trade",
          marketTitle: previous.title,
          outcome: previous.outcome,
          side: "SELL",
          price: closePrice,
          amount: previous.size,
          eventSlug: previous.eventSlug,
          marketSlug: previous.marketSlug,
          conditionId: previous.conditionId,
          assetId: previous.assetId
        });
        console.log(
          `   🔴 Fechou: ${previous.title.slice(0, 40)} - ${
            previous.outcome
          } | CondId: ${previous.conditionId.slice(
            0,
            8
          )} (${previous.size.toFixed(1)} shares)`
        );
      }
    }

    // ATUALIZA O SNAPSHOT
    portfolioSnapshots.set(address, {
      positions: currentMap,
      timestamp: Date.now()
    });

    // MELHORIA: Enriquece atividades com informações faltantes
    // IMPORTANTE: Processa cada conditionId único apenas uma vez
    const processedConditions = new Set<string>();

    for (const activity of activities) {
      // Verifica se precisa enriquecer E se ainda não processou esse conditionId
      const needsEnrichment =
        activity.marketTitle.startsWith("Market ") ||
        (!activity.eventSlug && !activity.marketSlug);

      if (
        needsEnrichment &&
        activity.conditionId &&
        !processedConditions.has(activity.conditionId)
      ) {
        const conditionId = activity.conditionId;
        const marketInfo = await getMarketInfo(conditionId, activity.assetId);
        if (marketInfo) {
          // Atualiza TODAS as atividades com o mesmo conditionId
          for (const act of activities) {
            if (act.conditionId === conditionId) {
              act.marketTitle = marketInfo.title;
              act.eventSlug = marketInfo.eventSlug;
              act.marketSlug = marketInfo.marketSlug;
            }
          }

          // Tenta obter clob meta para definir tid por outcome
          const meta = await getClobMeta(conditionId);
          if (meta && meta.clobTokenIds.length > 0) {
            for (const act of activities) {
              if (act.conditionId !== conditionId) continue;

              const outcome = (act.outcome || "").toLowerCase().trim();
              let tid: string | number | undefined;

              if (
                meta.outcomes.length === meta.clobTokenIds.length &&
                meta.outcomes.length > 0
              ) {
                // Mapeia por nome de outcome
                const idx = meta.outcomes.findIndex(
                  (o) => (o || "").toLowerCase().trim() === outcome
                );
                if (idx >= 0) tid = meta.clobTokenIds[idx];
              }

              // Fallback binário Yes/No: assume [Yes, No]
              if (!tid && meta.clobTokenIds.length === 2) {
                tid =
                  outcome === "yes"
                    ? meta.clobTokenIds[0]
                    : meta.clobTokenIds[1];
              }

              if (tid) {
                act.marketTid = tid;
              }
            }
          }

          processedConditions.add(conditionId);
          console.log(
            `   ✨ Enriquecido (${conditionId.slice(
              0,
              8
            )}): ${marketInfo.title.slice(0, 50)}`
          );
        }
        // Pequeno delay para não sobrecarregar
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    if (activities.length > 0) {
      console.log(`   ✅ Detectou ${activities.length} mudança(s)`);
    }

    return activities;
  } catch (error: any) {
    console.error(
      `❌ Erro ao monitorar ${address.slice(0, 8)}:`,
      error.message
    );
    return [];
  }
}

// 3. BUSCAR PORTFOLIO RAW (melhorado)
async function fetchPortfolioRaw(address: string): Promise<PolyPosition[]> {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: {
        user: address,
        size_gt: 0.01
      },
      headers: BROWSER_HEADERS,
      timeout: 10000,
      validateStatus: (status) => status < 500
    });

    if (response.status !== 200 || !Array.isArray(response.data)) {
      return [];
    }

    const positions: PolyPosition[] = [];

    for (const pos of response.data) {
      const size = Number(pos.size || 0);
      if (size < 0.01) continue;

      // IMPORTANTE: Captura conditionId PRIMEIRO (é o identificador único do mercado)
      const conditionId = pos.conditionId || pos.condition_id || "";
      const outcome = pos.outcome || "Unknown";
      const assetId = pos.asset || pos.assetId || "";

      // Validação: Pula se não tiver conditionId (não conseguiremos identificar o mercado)
      if (!conditionId) {
        console.warn(`⚠️ Posição sem conditionId, pulando...`);
        continue;
      }

      let title = "Unknown Market";
      let eventSlug = "";
      let marketSlug = "";

      // DEBUG: Vamos ver o que a API está retornando
      const marketData = pos.market || {};

      // SEMPRE busca via API usando conditionId (mais confiável)
      if (conditionId) {
        const marketInfo = await getMarketInfo(conditionId, assetId);
        if (marketInfo && marketInfo.title && marketInfo.title.length > 0) {
          title = marketInfo.title;
          eventSlug = marketInfo.eventSlug;
          marketSlug = marketInfo.marketSlug;
        } else {
          // Fallback: Tenta dados que vieram na posição
          if (marketData.question && marketData.question.length > 0) {
            title = marketData.question;
            marketSlug = marketData.slug || "";
            console.log(`   ⚠️ Fallback question: ${title.slice(0, 50)}`);
          } else if (marketData.title && marketData.title.length > 0) {
            title = marketData.title;
            marketSlug = marketData.slug || "";
            console.log(`   ⚠️ Fallback title: ${title.slice(0, 50)}`);
          } else if (marketData.slug && marketData.slug.length > 0) {
            title = marketData.slug
              .split("-")
              .map(
                (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
              )
              .join(" ");
            marketSlug = marketData.slug;
            console.log(`   ⚠️ Fallback slug: ${title.slice(0, 50)}`);
          } else {
            // Último recurso
            title = `Market ${conditionId.slice(0, 8)}`;
            console.warn(`   ❌ SEM DADOS para ${conditionId.slice(0, 8)}`);
          }
        }
      } else {
        title = `Market ${assetId.slice(0, 8)}`;
        console.warn(`   ❌ Posição sem conditionId!`);
      }

      const entryPrice = Number(pos.avgPrice || 0);
      let currentPrice = entryPrice;

      // Busca preço atual
      try {
        const priceReq = await axios.get(`${CLOB_API_URL}/price`, {
          params: { token_id: assetId, side: "mid" },
          headers: BROWSER_HEADERS,
          timeout: 2000,
          validateStatus: (status) => status < 500
        });

        const fetchedPrice = Number(priceReq.data?.price || 0);
        if (fetchedPrice > 0) {
          currentPrice = fetchedPrice;
        }
      } catch {
        if (
          pos.market?.outcomePrices &&
          Array.isArray(pos.market.outcomePrices)
        ) {
          const prices = pos.market.outcomePrices.map((p: any) => Number(p));
          if (outcome.toLowerCase() === "yes" && prices[0]) {
            currentPrice = prices[0];
          } else if (outcome.toLowerCase() === "no" && prices[1]) {
            currentPrice = prices[1];
          }
        }
      }

      const invested = size * entryPrice;
      const currentValue = size * currentPrice;
      const pnl = currentValue - invested;
      const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

      positions.push({
        title,
        outcome,
        size,
        entryPrice,
        currentPrice,
        pnl,
        pnlPercent,
        currentValue,
        eventSlug,
        marketSlug,
        assetId,
        conditionId
      });

      await new Promise((r) => setTimeout(r, 100)); // Aumentado para 100ms entre requisições
    }

    // Log resumido no final
    console.log(`   ✅ ${positions.length} posições carregadas`);
    if (positions.length > 0) {
      const uniqueMarkets = new Set(positions.map((p) => p.conditionId)).size;
      console.log(`   📊 ${uniqueMarkets} mercados únicos`);
    }

    return positions;
  } catch (error: any) {
    console.error(`❌ Erro ao buscar portfolio:`, error.message);
    return [];
  }
}

// 4. BUSCAR PORTFOLIO (para comando /portfolio, com cache)
const portfolioCache = new Map<
  string,
  { data: PolyPosition[]; timestamp: number }
>();
const CACHE_TTL = 30000;

export async function fetchPortfolio(address: string): Promise<PolyPosition[]> {
  try {
    const cached = portfolioCache.get(address);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`   💾 Usando cache para ${address.slice(0, 8)}`);
      return cached.data;
    }

    console.log(`📊 Buscando portfolio de ${address.slice(0, 8)}...`);
    const positions = await fetchPortfolioRaw(address);

    positions.sort((a, b) => b.currentValue - a.currentValue);

    console.log(`   └─ ${positions.length} posições ativas`);

    if (positions.length > 0) {
      portfolioCache.set(address, {
        data: positions,
        timestamp: Date.now()
      });
    }

    return positions;
  } catch (error: any) {
    console.error(`❌ Erro no fetchPortfolio:`, error.message);
    return [];
  }
}

// 5-7. Funções auxiliares (inalteradas)
export function clearCache(address: string): void {
  portfolioSnapshots.delete(address);
  portfolioCache.delete(address);
  usernameCache.delete(address);
  console.log(`🗑️ Cache limpo para ${address.slice(0, 8)}`);
}

export async function getUsernameFromAddress(
  address: string
): Promise<string | null> {
  const cached = usernameCache.get(address);
  if (cached && Date.now() - cached.timestamp < USERNAME_CACHE_TTL) {
    return cached.username;
  }

  try {
    const profileUrl = `https://polymarket.com/profile/${address}`;
    const { data: html } = await axios.get(profileUrl, {
      headers: BROWSER_HEADERS,
      timeout: 5000
    });

    const patterns = [
      /"username":"([^"]+)"/i,
      /"name":"([^"]+)"/i,
      /<title>([^<|]+)/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1] && !match[1].includes("Polymarket")) {
        const username = match[1].trim();
        usernameCache.set(address, { username, timestamp: Date.now() });
        return username;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

export async function testAPIConnection(address: string): Promise<void> {
  console.log(`\n🧪 TESTANDO APIs PARA ${address.slice(0, 8)}...\n`);

  console.log(`1️⃣ Testando DATA /positions...`);
  try {
    const data = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: address },
      headers: BROWSER_HEADERS,
      timeout: 5000,
      validateStatus: () => true
    });
    console.log(`   Status: ${data.status}`);
    console.log(
      `   Dados: ${
        Array.isArray(data.data)
          ? `${data.data.length} items`
          : "formato inválido"
      }`
    );

    if (data.data && data.data[0]) {
      const sample = data.data[0];
      console.log(`\n📋 SAMPLE DA PRIMEIRA POSIÇÃO:`);
      console.log(`   conditionId: ${sample.conditionId || "N/A"}`);
      console.log(`   outcome: ${sample.outcome || "N/A"}`);
      console.log(`   size: ${sample.size || "N/A"}`);
      console.log(`   market.question: ${sample.market?.question || "N/A"}`);
      console.log(`   market.title: ${sample.market?.title || "N/A"}`);
      console.log(`   market.slug: ${sample.market?.slug || "N/A"}`);

      // Testa buscar info desse mercado
      if (sample.conditionId) {
        console.log(
          `\n🔍 Testando getMarketInfo para ${sample.conditionId}...`
        );
        const assetId = sample.asset || sample.assetId || "";
        const info = await getMarketInfo(sample.conditionId, assetId);
        if (info) {
          console.log(`   ✅ Título: ${info.title}`);
          console.log(`   ✅ EventSlug: ${info.eventSlug || "(vazio)"}`);
          console.log(`   ✅ MarketSlug: ${info.marketSlug || "(vazio)"}`);
        } else {
          console.log(`   ❌ Não conseguiu buscar informações`);
        }
      }
    }
  } catch (e: any) {
    console.log(`   ❌ Erro: ${e.message}`);
  }

  console.log(`\n💡 FUNCIONAMENTO ATUAL:`);
  console.log(`   O bot monitora mudanças comparando snapshots do portfolio.`);
  console.log(`   Detecta: novas posições, aumentos, vendas e fechamentos.`);
  console.log(`   ⏱️ Verificação a cada 30s.\n`);
}
