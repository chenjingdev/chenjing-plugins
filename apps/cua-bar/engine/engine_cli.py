"""The engine commands behind `codex-cua`: status, release, release-session, stop, restart-codex, unlock-reset, settings
and diagnose.

Every command prints exactly one JSON object and exits 0 even when the action itself failed ("ok": false);
diagnose prints plain text. A non-zero exit means the command could not run at all. Output shapes and reasons
are those of the engine contract the menu bar app is built against.
"""
import json
import sys

from engine_core import Context

COMMANDS = ('status', 'release', 'release-session', 'stop', 'restart-codex', 'unlock-reset', 'settings', 'diagnose')
# Which of the option flags each command accepts.
OPTIONS = {'status': (), 'release': ('connection', 'ended'), 'release-session': ('session', 'user'),
           'stop': ('connection', 'group', 'force'), 'restart-codex': (), 'unlock-reset': (),
           'settings': ('error_text',), 'diagnose': ()}


def validate(args, error):
    """error(message) must not return (argparse's parser.error ends the process with status 2)."""
    given = {'connection': args.connection, 'ended': args.ended, 'session': args.session, 'user': args.user,
             'group': args.group, 'force': args.force, 'error_text': getattr(args, 'error_text', None)}
    for name, value in given.items():
        if value and name not in OPTIONS[args.command]:
            error('--%s is not used by %s' % (name.replace('_', '-'), args.command))
    if args.command == 'release' and bool(args.connection) == bool(args.ended):
        error('release needs exactly one of --connection ID or --ended')
    if args.command == 'release-session' and not args.session:
        error('release-session needs --session ID')
    if args.command == 'stop' and bool(args.connection) == bool(args.group):
        error('stop needs exactly one of --connection ID or --group all|claude|codex')
    if args.command == 'settings' and getattr(args, 'error_text', None) not in ('on', 'off'):
        error('settings needs --error-text on|off')


def execute(ctx, args):
    """The JSON object (or, for diagnose, the text) a command prints."""
    if args.command == 'status':
        from engine_status import status
        return status(ctx)
    if args.command == 'diagnose':
        from engine_diagnose import diagnose_text
        return diagnose_text(ctx)
    if args.command == 'restart-codex':
        from engine_actions import restart_codex
        return restart_codex(ctx)
    if args.command == 'unlock-reset':
        from engine_unlock import unlock_reset
        return unlock_reset(ctx)
    if args.command == 'settings':
        from engine_records import write_settings
        return write_settings(ctx.state_dir, ctx.uid, args.error_text == 'on')
    if args.command == 'release-session':
        from engine_release import release_session_command
        return release_session_command(ctx, args.session, user=args.user)
    if args.command == 'release':
        from engine_actions import release_connection, release_ended
        return release_ended(ctx) if args.ended else release_connection(ctx, args.connection)
    from engine_actions import stop_connection, stop_group
    if args.group:
        return stop_group(ctx, args.group, force=args.force)
    return stop_connection(ctx, args.connection, force=args.force)


def run_command(args, plugin_root, setup_module=None, error=None, context=None, stdout=None):
    validate(args, error or (lambda message: sys.exit(2)))
    ctx = context or Context(plugin_root, setup=setup_module)
    result = execute(ctx, args)
    stream = stdout or sys.stdout
    stream.write(result if isinstance(result, str) else json.dumps(result)+'\n')
    stream.flush()
    return 0
