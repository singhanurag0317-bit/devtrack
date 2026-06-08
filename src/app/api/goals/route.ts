import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveAppUser } from "@/lib/resolve-user";
import { dispatchToAllWebhooks } from "@/lib/webhooks";
import { stripHtml } from "@/lib/sanitize";
import { extractValidRepoFromGoal } from "@/lib/goals-sync-utils";

export const dynamic = "force-dynamic";

interface Goal {  
  id: string;
  user_id: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  type: string;
  recurrence: string;
  deadline: string | null;
  period_start: string | null;
  created_at: string;
  goal_reset_version: number;
  is_public: boolean;
}

interface GoalHistory {
  goal_id: string;
  period_start: string;
  period_end: string;
  target: number;
  achieved: number;
  completed: boolean;
}

type Recurrence = "none" | "weekly" | "monthly";

const VALID_RECURRENCES = ["none", "weekly", "monthly"] as const;
const MAX_TITLE_LEN = 100;
const MAX_UNIT_LEN = 30;
const MIN_TARGET = 1;
const MAX_TARGET = 10_000;

// Hard cap to prevent storage exhaustion and catastrophic Promise.all execution
const MAX_GOALS_PER_USER = 5;

function getPeriodStart(recurrence: Recurrence): string {
  const now = new Date();
  if (recurrence === "weekly") {
    const day = now.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() + diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString();
  }
  if (recurrence === "monthly") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
  return new Date(0).toISOString(); // 'none' never resets
}

function getPreviousPeriodEnd(periodStart: Date): string {
  return new Date(periodStart.getTime() - 1).toISOString();
}

function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function currentWeekEnd(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 0 : 7 - day;
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() + diff);
  sunday.setUTCHours(23, 59, 59, 999);
  return sunday.toISOString();
}

const GITHUB_API = "https://api.github.com";

async function fetchCommitsCount(
  githubLogin: string,
  accessToken: string,
  weekStart: string,
  weekEnd: string,
  repo: string | null
): Promise<number> {
  let page = 1;
  let commitCount = 0;
  let hasMore = true;

  while (hasMore) {
    const qParts = [`author:${githubLogin}`];
    if (repo) qParts.push(`repo:${repo}`);
    qParts.push(`author-date:${weekStart}..${weekEnd}`);

    const commitSearchParams = new URLSearchParams({
      q: qParts.join(" "),
      per_page: "100",
      page: String(page),
    });

    const ghRes = await fetch(
      `${GITHUB_API}/search/commits?${commitSearchParams.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
        cache: "no-store",
      }
    );

    if (!ghRes.ok) {
      throw new Error(`GitHub API error: ${ghRes.status}`);
    }

    const ghData = (await ghRes.json()) as {
      items?: unknown[];
    };

    const items = ghData.items || [];
    commitCount += items.length;

    if (items.length < 100) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return commitCount;
}

async function fetchPRsCount(
  githubLogin: string,
  accessToken: string,
  weekStart: string,
  weekEnd: string
): Promise<number> {
  const prSearchParams = new URLSearchParams({
    q: `author:${githubLogin} type:pr is:merged merged:${weekStart}..${weekEnd}`,
    per_page: "1",
  });

  const prRes = await fetch(
    `${GITHUB_API}/search/issues?${prSearchParams.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    }
  );

  if (!prRes.ok) {
    throw new Error(`GitHub API error: ${prRes.status}`);
  }

  const prData = (await prRes.json()) as { total_count?: number };
  return prData.total_count || 0;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.githubId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await resolveAppUser(session.githubId, session.githubLogin);
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  // Added .limit() to bound the database payload and the subsequent Promise.all loop
  const { data: goals, error } = await supabaseAdmin
    .from("goals")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(MAX_GOALS_PER_USER);

  if (error) {
    console.error("Failed to fetch goals:", error);
    return Response.json({ error: "Failed to fetch goals" }, { status: 500 });
  }

  // Reset progress if we're in a new period
  const processedGoals = await Promise.all(
    (goals ?? []).map(async (goal: Goal) => {
      let currentGoal = { ...goal };

      if (currentGoal.recurrence !== "none") {
        const periodStart = new Date(getPeriodStart(currentGoal.recurrence as Recurrence));
        const storedPeriodStart = currentGoal.period_start
          ? new Date(currentGoal.period_start)
          : new Date(0);

        if (storedPeriodStart < periodStart) {
          let achieved = currentGoal.current;

          if (session?.accessToken && session.githubLogin) {
            const prevStart = storedPeriodStart.toISOString();
            const prevEnd = getPreviousPeriodEnd(periodStart);
            if (currentGoal.type === "commits") {
              try {
                const repo = extractValidRepoFromGoal(currentGoal as any);
                achieved = await fetchCommitsCount(
                  session.githubLogin,
                  session.accessToken,
                  prevStart,
                  prevEnd,
                  repo
                );
              } catch (e) {
                console.error("Failed to fetch previous period commits", e);
              }
            } else if (currentGoal.type === "prs") {
              try {
                achieved = await fetchPRsCount(
                  session.githubLogin,
                  session.accessToken,
                  prevStart,
                  prevEnd
                );
              } catch (e) {
                console.error("Failed to fetch previous period PRs", e);
              }
            }
          }

          const oldVersion = currentGoal.goal_reset_version ?? 0;

          const { error: historyError } = await supabaseAdmin
            .from("goal_history")
            .insert({
              goal_id: currentGoal.id,
              user_id: currentGoal.user_id,
              period_start: storedPeriodStart.toISOString(),
              period_end: getPreviousPeriodEnd(periodStart),
              target: currentGoal.target,
              achieved: achieved,
              completed: achieved >= currentGoal.target,
            });
          
          if (historyError && historyError.code !== "23505") {
            console.error("Failed to persist goal history before reset:", historyError);
            return currentGoal;
          }
          
          const { data: updated, error } = await supabaseAdmin
            .from("goals")
            .update({
              current: 0,
              period_start: periodStart.toISOString(),
              goal_reset_version: oldVersion + 1,
            })
            .eq("id", currentGoal.id)
            .eq("goal_reset_version", oldVersion)
            .or(`period_start.lt.${periodStart.toISOString()},period_start.is.null`)
            .select()
            .single();
        
          if (updated) {
            currentGoal = updated;
          } else {
            if (error) {
              console.warn("[GOAL_RESET_CONFLICT]", {
                goalId: currentGoal.id,
                oldVersion,
                error,
              });
            }
            const { data: current } = await supabaseAdmin
              .from("goals")
              .select("*")
              .eq("id", currentGoal.id)
              .single();
            if (current) currentGoal = current;
          }
        }
      }

      // Fetch dynamic value for current period if it is an auto-progress goal type
      if (session?.accessToken && session.githubLogin) {
        if (currentGoal.type === "commits") {
          try {
            const repo = extractValidRepoFromGoal(currentGoal as any);
            const weekStart = currentGoal.period_start || currentWeekStart();
            const weekEnd = currentWeekEnd();
            const count = await fetchCommitsCount(
              session.githubLogin,
              session.accessToken,
              weekStart,
              weekEnd,
              repo
            );
            await supabaseAdmin
              .from("goals")
              .update({ current: count, last_synced_at: new Date().toISOString() })
              .eq("id", currentGoal.id);
            currentGoal.current = count;
          } catch (e) {
            console.error("Failed to dynamically fetch commits for goal", currentGoal.id, e);
          }
        } else if (currentGoal.type === "prs") {
          try {
            const weekStart = currentGoal.period_start || currentWeekStart();
            const weekEnd = currentWeekEnd();
            const count = await fetchPRsCount(
              session.githubLogin,
              session.accessToken,
              weekStart,
              weekEnd
            );
            await supabaseAdmin
              .from("goals")
              .update({ current: count, last_synced_at: new Date().toISOString() })
              .eq("id", currentGoal.id);
            currentGoal.current = count;
          } catch (e) {
            console.error("Failed to dynamically fetch PRs for goal", currentGoal.id, e);
          }
        }
      }

      return currentGoal;
    })
  );

  const goalIds = processedGoals
    .map((goal) => goal?.id)
    .filter((id): id is string => Boolean(id));

  let latestHistoryByGoal = new Map<string, GoalHistory>();
  if (goalIds.length > 0) {
    const { data: histories } = await supabaseAdmin
      .from("goal_history")
      .select("goal_id, period_start, period_end, target, achieved, completed")
      .eq("user_id", user.id)
      .in("goal_id", goalIds)
      .order("period_end", { ascending: false });

    latestHistoryByGoal = new Map<string, GoalHistory>();
    for (const history of (histories ?? []) as GoalHistory[]) {
      if (!latestHistoryByGoal.has(history.goal_id)) {
        latestHistoryByGoal.set(history.goal_id, history);
      }
    }
  }

  const goalsWithHistory = processedGoals.map((goal) => ({
    ...goal,
    last_period: latestHistoryByGoal.get(goal.id) ?? null,
  }));

  return Response.json({ goals: goalsWithHistory });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.githubId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

try {
  body = await req.json();
} catch (e) {
  return Response.json({ error: "Invalid JSON" }, { status: 400 });
}


  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { title, target, unit, recurrence, deadline, type } = body as Record<string, unknown>;

  if (typeof title !== "string" || title.trim().length === 0) {
    return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
  }
  const sanitizedTitle = stripHtml(title);
  if (sanitizedTitle.length === 0) {
    return Response.json({ error: "title must not be empty" }, { status: 400 });
  }
  if (sanitizedTitle.length > MAX_TITLE_LEN) {
    return Response.json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer` }, { status: 400 });
  }
  if (
    typeof target !== "number" ||
    !Number.isInteger(target) ||
    target < MIN_TARGET ||
    target > MAX_TARGET
  ) {
    return Response.json(
      { error: `target must be an integer between ${MIN_TARGET} and ${MAX_TARGET}` },
      { status: 400 }
    );
  }

  const safeUnit = typeof unit === "string" ? unit.slice(0, MAX_UNIT_LEN) : "commits";
  const safeRecurrence: Recurrence = VALID_RECURRENCES.includes(recurrence as Recurrence)
    ? (recurrence as Recurrence)
    : "none";

  const VALID_TYPES = ["commits", "prs", "manual"] as const;
  const safeType = VALID_TYPES.includes(type as any) ? (type as string) : "manual";

  let safeDeadline: string | null = null;
  if (typeof deadline === "string") {
    const d = new Date(deadline);
    if (!isNaN(d.getTime())) {
      d.setUTCHours(23, 59, 59, 999);
      safeDeadline = d.toISOString();
    }
  }

  const user = await resolveAppUser(session.githubId, session.githubLogin);
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  // Pre-check count query using head option for peak performance
  const { count, error: countError } = await supabaseAdmin
    .from("goals")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (countError) {
    return Response.json({ error: "Failed to verify goal limits" }, { status: 500 });
  }

  if ((count ?? 0) >= MAX_GOALS_PER_USER) {
    return Response.json(
      { error: `You can have at most ${MAX_GOALS_PER_USER} goals.` },
      { status: 400 }
    );
  }

  const { data: goal, error } = await supabaseAdmin
    .from("goals")
    .insert({
      user_id: user.id,
      title: sanitizedTitle,
      target,
      unit: safeUnit,
      type: safeType,
      recurrence: safeRecurrence,
      period_start: getPeriodStart(safeRecurrence),
      deadline: safeDeadline,
      current: 0,
      goal_reset_version: 0,
    })
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  dispatchToAllWebhooks(user.id, "goal.created", {
    goalId: goal.id,
    title: goal.title,
    target: goal.target,
    unit: goal.unit,
    recurrence: goal.recurrence,
  }).catch(() => {});

  return Response.json({ goal }, { status: 201 });
}
