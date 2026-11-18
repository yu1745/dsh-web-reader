window.__ModuleLoader__.load({
  id: '@yu1745/dsh-web-reader',
  factory(require) {
    const { createElement: h, useEffect, useId, useState } = require('react');
    const ref = 'TYPESAFE_API_KEY';
    function metadata(result) {
      if (!result?.ok) throw new Error();
      const info = result.value[ref];
      return { configured: info.configured, writable: info.writable, source: info.source };
    }
    function View({ credentials }) {
      const id = useId();
      const [info, setInfo] = useState(null);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      useEffect(() => {
        let active = true;
        Promise.resolve().then(() => credentials.describe([ref])).then(metadata).then(value => {
          if (active) setInfo(value);
        }).catch(() => { if (active) setError('无法读取密钥状态。'); });
        return () => { active = false; };
      }, [credentials]);
      async function update(clear) {
        if (busy || !info?.writable || (!clear && !draft.trim())) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          const result = clear ? await credentials.unset(ref) : await credentials.set(ref, draft.trim());
          if (!result?.ok) throw new Error();
          setDraft('');
          setInfo(null);
          setMessage(clear ? '已清除保存的密钥。' : '已保存，下次网页读取时生效。');
          try { setInfo(metadata(await credentials.describe([ref]))); }
          catch { setError('密钥已更新，暂时无法读取状态。'); }
        } catch {
          setError(clear ? '无法清除密钥。' : '无法保存密钥。');
        } finally { setBusy(false); }
      }
      return h('section', { style: { marginBlockStart: 24, paddingBlockStart: 16, borderBlockStart: '1px solid var(--dsw-alias-border-l1)' }, 'aria-labelledby': `${id}-title` },
        h('h3', { id: `${id}-title` }, 'TypeSafe Jev'),
        h('p', { id: `${id}-help` }, '用于判断网页是否已加载。密钥保存在 DSH 凭据服务中。'),
        h('form', { 'aria-labelledby': `${id}-title`, onSubmit: event => { event.preventDefault(); void update(false); } },
          h('label', { htmlFor: id, style: { display: 'block', marginBlockEnd: 4 } }, 'TypeSafe API 密钥'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h('input', { id, type: 'password', autoComplete: 'new-password', spellCheck: false, value: draft, disabled: busy || !info?.writable, 'aria-describedby': `${id}-help ${id}-status`, onChange: event => setDraft(event.target.value) }),
            h('button', { type: 'submit', disabled: busy || !info?.writable || !draft.trim() }, '保存'),
            h('button', { type: 'button', disabled: busy || !info?.writable || info.source !== 'file', onClick: () => void update(true) }, '清除')),
          h('p', { id: `${id}-status`, role: 'status' }, message || (info ? `${info.configured ? '已配置' : '未配置'}${info.writable ? '' : ' · 只读'}` : error ? '' : '正在读取…')),
          error && h('p', { role: 'alert' }, error)));
    }
    return {
      inject: ['slots', 'remote.credentials'],
      apply(ctx) {
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'yu-web-reader-jev-key', order: 100 }, () => h(View, { credentials: ctx.remote.credentials })));
      },
    };
  },
});
