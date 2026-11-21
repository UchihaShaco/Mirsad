import { ok } from '../../contract/errors.ts';
import { ListChatsQuery, RegisterChatRequest } from '../../contract/schemas.ts';
import { listChats, registerChat } from '../../services/chats.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseJsonBody, parseQuery } from '../middleware/validate.ts';

const CREATED = 201;
const OK = 200;

export const routes: RouteModule = {
  'POST /v1/chats': async (c, deps) => {
    const officer = principalOf(c);
    const body = await parseJsonBody(c, RegisterChatRequest);
    const result = deps.db.transaction((tx) => registerChat(tx, officer, body));
    return c.json(ok(result), result.created ? CREATED : OK);
  },
  'GET /v1/chats': (c, deps) => {
    const officer = principalOf(c);
    const query = parseQuery(c, ListChatsQuery);
    const { chats, cursor, total } = deps.db.transaction((tx) => listChats(tx, officer, query));
    return c.json(ok({ chats, cursor }, { total, limit: query.limit, offset: query.offset }));
  },
};
