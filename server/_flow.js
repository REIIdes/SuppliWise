const fs = require('fs');
const mem = fs.readFileSync(process.env.TEMP + '\\member_token.txt', 'utf8').trim();
const adm = process.argv[2];
const B = 'http://localhost:5000/api';
const MH = () => ({ Authorization: `Bearer ${mem}`, 'Content-Type': 'application/json' });
const AH = () => ({ Authorization: `Bearer ${adm}`, 'Content-Type': 'application/json' });
let pass = 0, fail = 0;
const check = (label, ok, extra) => { if (ok) { pass++; console.log('   ok  ' + label); } else { fail++; console.log('  FAIL ' + label + (extra ? ' -> ' + extra : '')); } };
const hit = async (p, hdrs, init) => {
  const r = await fetch(B + p, { ...init, headers: hdrs });
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 80) }; }
  return { status: r.status, body: j };
};
const post = (p, hdrs, body) => hit(p, hdrs, { method: 'POST', body: JSON.stringify(body ?? {}) });

(async () => {
  const c = await post('/support-chat', MH(), { subject: 'Cannot download my report', category: 'technical', body: 'The PDF button does nothing.' });
  const id = c.body.thread._id;
  check('member starts a conversation', c.status === 201, c.status);
  await post(`/admin/chats/${id}/messages`, AH(), { body: 'Try again in a private window.' });

  console.log('\n--- ADMIN resolves (the only resolve) ---');
  const r1 = await post(`/admin/chats/${id}/resolve`, AH());
  check('admin resolve -> 200', r1.status === 200, r1.status);
  check('status is resolved', r1.body.thread.status === 'resolved');
  check('resolver is an admin alias, not "member"', r1.body.thread.resolved.by !== 'member', r1.body.thread.resolved.by);

  console.log('\n--- nobody can change that state, nobody can write ---');
  const m1 = await post(`/support-chat/${id}/resolve`, MH());
  check('member resolve endpoint does not exist (404)', m1.status === 404, m1.status);
  const m2 = await post(`/support-chat/${id}/reopen`, MH());
  check('member reopen endpoint does not exist (404)', m2.status === 404, m2.status);
  const m3 = await post(`/support-chat/${id}/messages`, MH(), { body: 'Any news?' });
  check('member reply refused (409)', m3.status === 409, m3.status);
  const a1 = await post(`/admin/chats/${id}/messages`, AH(), { body: 'one more thing' });
  check('admin reply ALSO refused (409)', a1.status === 409, a1.status);
  const v = await hit(`/support-chat/${id}`, MH());
  check('no stray messages were written', v.body.messages.length === 2, v.body.messages.length);
  check('still resolved', v.body.thread.status === 'resolved');

  console.log('\n--- ADMIN reopens -> both sides can write again ---');
  const re = await post(`/admin/chats/${id}/reopen`, AH());
  check('admin reopen -> 200', re.status === 200, re.status);
  check('resolved stamp cleared', !re.body.thread.resolved.at);
  check('back in the working queue', re.body.thread.status === 'open', re.body.thread.status);
  const a2 = await post(`/admin/chats/${id}/messages`, AH(), { body: 'It is fixed now.' });
  check('admin can reply after reopen', a2.status === 201, a2.status);
  const m4 = await post(`/support-chat/${id}/messages`, MH(), { body: 'Confirmed, thanks!' });
  check('member can reply after reopen', m4.status === 201, m4.status);

  await post(`/admin/chats/${id}/resolve`, AH());
  console.log('\nTHREAD_ID=' + id);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
