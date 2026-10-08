"""Memory management through the real host and file-backed extension service."""
import unittest
from pathlib import Path
from types import SimpleNamespace

from fox_coding_agent.src.extensions.memory.extension import MemoryExtensionConfig, MemoryService
from fox_coding_agent.src.extensions.memory.store import MemoryStore
from fox_serve.host import HostError, ServeHost
from fox_serve.tests._tmp import temp_dir_obj


class MemoryCommandsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = temp_dir_obj()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.service = MemoryService(MemoryExtensionConfig())
        self.service.store = MemoryStore(self.root / 'user', self.root / 'workspace')
        self.service.project_trusted = True
        self.service.source_session = 'test-session'
        self.host = ServeHost(cwd=self.root / 'workspace', user_dir=self.root / 'user')
        api = SimpleNamespace(get_service=lambda name: self.service if name == 'memory.store' else None)
        self.host._runtime = SimpleNamespace(agent_session=SimpleNamespace(extensions=SimpleNamespace(api=api)))

    async def create(self, **values):
        return (await self.host.handle('memory.save', {
            'name': '语言偏好', 'description': '默认回复语言', 'type': 'user',
            'content': '默认使用简体中文回复。', **values,
        }))['entry']

    async def test_create_edit_pin_search_delete_and_persistence(self):
        entry = await self.create()
        filename = entry['filename']
        self.assertEqual(self.service.store.read(filename).source_session, 'test-session')
        await self.host.handle('memory.save', {'filename': filename, 'pinned': True})
        await self.host.handle('memory.save', {'filename': filename, 'content': '代码注释使用英文，交流使用中文。'})
        reopened = MemoryStore(self.root / 'user', self.root / 'workspace').read(filename)
        self.assertTrue(reopened.pinned)
        self.assertIn('代码注释', reopened.content)
        result = await self.host.handle('memory.list', {'query': '注释'})
        self.assertEqual(result['entries'][0]['filename'], filename)
        self.assertEqual((await self.host.handle('memory.list', {'query': 'does-not-exist'}))['entries'], [])
        self.assertTrue((await self.host.handle('memory.delete', {'filename': filename}))['deleted'])
        self.assertFalse((await self.host.handle('memory.delete', {'filename': filename}))['deleted'])
        self.assertEqual(self.service.store.list(), [])
        self.assertNotIn(filename, self.service.store.index_path.read_text())

    async def test_trust_extension_and_busy_guards(self):
        self.service.project_trusted = False
        for method, params in [('memory.list', {}), ('memory.save', {}), ('memory.delete', {'filename': 'x'})]:
            with self.assertRaises(HostError):
                await self.host.handle(method, params)
        self.service.project_trusted = True
        self.host._running_runtimes.add(id(self.host._runtime))
        for method in ('memory.save', 'memory.delete'):
            with self.assertRaisesRegex(HostError, 'Agent'):
                await self.host.handle(method, {})
        self.host._runtime.agent_session.extensions.api.get_service = lambda name: None
        with self.assertRaisesRegex(HostError, '启用'):
            await self.host.handle('memory.list')

    async def test_invalid_fields_secrets_and_paths_do_not_change_files(self):
        entry = await self.create()
        for values in [
            {'filename': '../settings.json', 'pinned': True},
            {'filename': entry['filename'], 'name': 'changed identity'},
            {'filename': entry['filename'], 'pinned': 'false'},
            {'filename': entry['filename'], 'content': 'api_key=abcdefghijklmnopqrstuvw'},
            {'filename': entry['filename'], 'content': ''},
            {'filename': entry['filename'], 'content': 'x' * 20001},
            {'filename': entry['filename'], 'status': 'active'},
        ]:
            with self.assertRaises(HostError):
                await self.host.handle('memory.save', values)
        with self.assertRaises(HostError):
            await self.host.handle('memory.delete', {'filename': '../settings.json'})
        self.assertEqual(self.service.store.read(entry['filename']).content, entry['content'])

    async def test_editing_history_preserves_status_and_metadata(self):
        old = await self.create()
        self.service.store.save(name='新语言偏好', description='新的语言选择', type='user', content='默认使用英文回复。', topic=old['topic'])
        updated = (await self.host.handle('memory.save', {'filename': old['filename'], 'pinned': True}))['entry']
        self.assertEqual(updated['status'], 'superseded')
        self.assertEqual(updated['source_session'], 'test-session')
        self.assertEqual(updated['created_at'], old['created_at'])

    async def test_distinct_chinese_names_do_not_supersede_each_other(self):
        first = await self.create()
        second = await self.create(name='测试约定', content='修改代码后运行相关测试。')
        self.assertNotEqual(first['topic'], second['topic'])
        self.assertEqual({entry.status for entry in self.service.store.list()}, {'active'})
        updated = await self.create(content='默认使用中文，术语可使用英文。')
        self.assertEqual(updated['filename'], first['filename'])
        self.assertEqual(len(self.service.store.list()), 2)

    async def test_workspace_isolation(self):
        await self.create()
        self.service.store = MemoryStore(self.root / 'user', self.root / 'another-workspace')
        self.assertEqual((await self.host.handle('memory.list'))['entries'], [])


class MemoryRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_management_before_first_prompt_and_after_reload(self):
        import json
        with temp_dir_obj() as directory:
            root = Path(directory)
            workspace = root / 'workspace'
            user = root / 'user'
            workspace.mkdir()
            user.mkdir()
            (user / 'settings.json').write_text(json.dumps({'extensions': [
                'module:fox_coding_agent.src.extensions.memory:setup'
            ]}))
            host = ServeHost(cwd=workspace, user_dir=user)
            await host.start()
            try:
                self.assertFalse(host._runtime._extensions_started)
                self.assertEqual((await host.handle('memory.list'))['entries'], [])
                saved = await host.handle('memory.save', {
                    'name': 'Project rule', 'description': 'Long-lived rule',
                    'type': 'project', 'content': 'Run tests after code changes.'
                })
                await host.handle('reload')
                self.assertEqual((await host.handle('memory.list'))['entries'][0]['filename'], saved['entry']['filename'])
                # Management never sends a model request or starts all hooks.
                self.assertFalse(host._runtime._extensions_started)
                await host.handle('trust.set', {'trusted': False})
                with self.assertRaises(HostError):
                    await host.handle('memory.list')
                await host.handle('trust.set', {'trusted': True})
                self.assertEqual(len((await host.handle('memory.list'))['entries']), 1)
                other = root / 'other'
                other.mkdir()
                await host.handle('cwd.change', {'cwd': str(other)})
                self.assertEqual((await host.handle('memory.list'))['entries'], [])
            finally:
                await host.stop()

    async def test_extension_toggle_preserves_memory_and_derives_tool_selection(self):
        import json
        with temp_dir_obj() as directory:
            root = Path(directory)
            workspace, user = root / 'workspace', root / 'user'
            workspace.mkdir(); user.mkdir()
            spec = 'module:fox_coding_agent.src.extensions.memory:setup'
            (user / 'settings.json').write_text(json.dumps({'extensions': [spec]}))
            host = ServeHost(cwd=workspace, user_dir=user)
            await host.start()
            try:
                session = host._runtime.agent_session
                memory_tools = {'memory_forget', 'memory_recall', 'memory_remember'}
                self.assertTrue(memory_tools <= set(session.selected_tool_names))
                self.assertFalse(memory_tools & set(session.session.build_settings()['active_tools']))
                # Normalize transcripts created before extension tools became ephemeral.
                session.session.append_active_tools_change(list(session.selected_tool_names))
                await host.handle('reload')
                session = host._runtime.agent_session
                self.assertFalse(memory_tools & set(session.session.build_settings()['active_tools']))
                saved = (await host.handle('memory.save', {
                    'name': 'Project rule', 'description': 'Long-lived rule',
                    'type': 'project', 'content': 'Run tests after code changes.'
                }))['entry']
                await host.handle('extensions.set', {'id': 'memory', 'enabled': False})
                self.assertFalse(memory_tools & set(host._runtime.agent_session.selected_tool_names))
                with self.assertRaisesRegex(HostError, '启用'):
                    await host.handle('memory.list')
                await host.handle('extensions.set', {'id': 'memory', 'enabled': True})
                self.assertTrue(memory_tools <= set(host._runtime.agent_session.selected_tool_names))
                self.assertEqual((await host.handle('memory.list'))['entries'][0]['filename'], saved['filename'])
                fork = host._runtime.agent_session.fork()
                self.assertTrue(memory_tools <= set(fork.selected_tool_names))
                self.assertFalse(memory_tools & set(fork.session.build_settings()['active_tools']))
            finally:
                await host.stop()
