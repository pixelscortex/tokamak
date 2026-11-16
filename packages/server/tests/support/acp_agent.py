
import sys, json, os
assert os.environ.get('ACP_TEST_PASSTHROUGH') == 'from-dotenv'
assert 'HOME' not in os.environ
assert 'ACP_TEST_UNLISTED' not in os.environ
assert 'PATH' not in os.environ
pending = None
cancelled = False

def send(value):
    print(json.dumps(dict(jsonrpc='2.0', **value)), flush=True)

def response(request, result):
    send(dict(id=request['id'], result=result))

for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        if os.environ.get('ACP_TEST_HANG_INITIALIZE'):
            import time; time.sleep(60)
        assert not params.get('clientCapabilities', {}).get('terminal', False)
        assert not params.get('clientCapabilities', {}).get('fs', {}).get('readTextFile', False)
        response(request, dict(protocolVersion=1, agentCapabilities={} if os.environ.get("ACP_TEST_NO_RESTORE") else dict(loadSession=True, sessionCapabilities=dict(resume={}))))
        send(dict(id='fs', method='fs/read_text_file', params=dict(path='/tmp/file')))
        send(dict(id='terminal', method='terminal/create', params=dict(command='echo')))
    elif request.get('id') in ['fs', 'terminal']:
        assert request['error']['code'] == -32601
    elif method in ['session/new', 'session/resume', 'session/load']:
        if params.get('cwd') == '/var':
            send(dict(id=request['id'], error=dict(code=-32000, message='Authentication required')))
            continue
        response(request, dict(sessionId=params.get('sessionId', 'session')))
    elif method == 'session/prompt':
        text = params['prompt'][0]['text']
        if text.startswith('Previous conversation:'):
            send(dict(method='session/update', params=dict(sessionId='session', update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text=text)))))
            response(request, dict(stopReason='end_turn'))
            continue
        if text.startswith('chat:'):
            mode = text[5:]
            def update(**value):
                send(dict(method='session/update', params=dict(sessionId='session', update=value)))
            update(sessionUpdate='agent_message_chunk', content=dict(type='text', text='Before.'))
            update(sessionUpdate='tool_call', toolCallId='chat-tool', title='Read file', kind='read', rawInput=dict(path='file'))
            update(sessionUpdate='tool_call_update', toolCallId='chat-tool', status='in_progress', title='Reading file')
            update(sessionUpdate='plan', entries=[dict(content='Old', status='pending', priority='low')])
            update(sessionUpdate='plan', entries=[dict(content='Read', status='completed', priority='high')])
            update(sessionUpdate='agent_thought_chunk', content=dict(type='text', text='hidden'))
            if mode == 'cancel':
                pending = request
                cancelled = True
                continue
            update(sessionUpdate='tool_call_update', toolCallId='chat-tool', status='completed', content=[dict(type='content', content=dict(type='text', text='Result'))], rawOutput='x' * 9000)
            update(sessionUpdate='agent_message_chunk', content=dict(type='image', data='ignored'))
            if mode == 'permission':
                pending = request
                send(dict(id='permission', method='session/request_permission', params=dict(sessionId='session', toolCall=dict(toolCallId='call', title='Run command'), options=[dict(optionId='yes', name='Allow once', kind='allow_once')])))
                continue
            response(request, dict(stopReason=mode if mode in ['refusal', 'cancelled', 'max_tokens', 'max_turn_requests'] else 'end_turn'))
            continue
        if text == 'huge-line':
            sys.stdout.write('x' * (1024 * 1024 + 1))
            sys.stdout.flush()
            continue
        if text == 'flood':
            for _ in range(20):
                send(dict(method='session/update', params=dict(sessionId='session', update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text='x' * 600000)))))
            continue
        if text == 'stderr-held':
            import subprocess
            descendant = subprocess.Popen(
                [sys.executable, '-c', 'import time; time.sleep(60)'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                start_new_session=True)
            sys.stderr.write('ACP_STDERR_CHILD:' + str(descendant.pid) + ':ACP_HELD_TAIL')
            sys.stderr.flush()
            sys.exit(9)
        if text == 'crash':
            sys.stderr.write('x' * 3000 + 'ACP_CRASH_TAIL')
            sys.stderr.flush()
            sys.exit(9)
        if text in ['permission', 'cancel', 'ignore-cancel']:
            pending = request
            send(dict(id='permission', method='session/request_permission', params=dict(sessionId='session', toolCall=dict(toolCallId='call', title='Run command'), options=[dict(optionId='yes', name='Allow once', kind='allow_once')])))
        else:
            send(dict(method='session/update', params=dict(sessionId='session', update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text='hello')))))
            response(request, dict(stopReason='end_turn'))
    elif method == 'session/cancel':
        if pending['params']['prompt'][0]['text'] == 'ignore-cancel':
            continue
        assert cancelled, 'pending permission must be cancelled before notification'
        response(pending, dict(stopReason='cancelled'))
    elif request.get('id') == 'permission':
        outcome = request['result']['outcome']
        cancelled = outcome['outcome'] == 'cancelled'
        if cancelled and pending['params']['prompt'][0]['text'] == 'chat:permission':
            response(pending, dict(stopReason='end_turn'))
        if not cancelled:
            assert outcome == dict(outcome='selected', optionId='yes')
            response(pending, dict(stopReason='end_turn'))
