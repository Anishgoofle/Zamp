import type { Schema } from '@engine';

/**
 * The scenario the UI opens with: `ours` and `theirs` both edit `base`, most of
 * it merges cleanly, and `posts.title`'s type conflicts.
 */
export const base: Schema = {
  tables: [
    {
      id: 't_users',
      name: 'users',
      columns: [
        { id: 'c_uid', name: 'id', type: { kind: 'int' }, nullable: false, constraints: [{ kind: 'primary_key' }] },
        { id: 'c_email', name: 'email', type: { kind: 'text' }, nullable: false, constraints: [] },
      ],
    },
    {
      id: 't_posts',
      name: 'posts',
      columns: [
        { id: 'c_pid', name: 'id', type: { kind: 'int' }, nullable: false, constraints: [{ kind: 'primary_key' }] },
        { id: 'c_title', name: 'title', type: { kind: 'text' }, nullable: false, constraints: [] },
        {
          id: 'c_author',
          name: 'author_id',
          type: { kind: 'int' },
          nullable: false,
          constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_uid' }],
        },
      ],
    },
  ],
};

const from = (edit: (s: Schema) => void): Schema => {
  const next = structuredClone(base);
  edit(next);
  return next;
};

// rename email, add created_at, widen title to varchar(200)
export const ours = from((s) => {
  const users = s.tables[0].columns;
  users[1].name = 'email_address';
  users.push({
    id: 'c_created',
    name: 'created_at',
    type: { kind: 'timestamp', withTimezone: true },
    nullable: false,
    constraints: [{ kind: 'default', expr: 'now()' }],
  });
  s.tables[1].columns[1].type = { kind: 'varchar', length: 200 };
});

// make email unique, add a tags table, widen title to varchar(120) — conflicts with ours
export const theirs = from((s) => {
  s.tables[0].columns[1].constraints = [{ kind: 'unique' }];
  s.tables[1].columns[1].type = { kind: 'varchar', length: 120 };
  s.tables.push({
    id: 't_tags',
    name: 'tags',
    columns: [
      { id: 'c_tid', name: 'id', type: { kind: 'int' }, nullable: false, constraints: [{ kind: 'primary_key' }] },
      { id: 'c_label', name: 'label', type: { kind: 'text' }, nullable: false, constraints: [{ kind: 'unique' }] },
    ],
  });
});
