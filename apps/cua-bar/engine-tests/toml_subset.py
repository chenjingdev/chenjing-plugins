"""A strict reader for the TOML subset that relay_install writes: inline tables, arrays, basic strings, numbers
and booleans. It exists so tests can check the text of a `-c` override without a TOML library (Python 3.9 has none).
Anything outside the subset raises ValueError."""
import re

_NUMBER = re.compile(r'[+-]?\d+(\.\d+)?([eE][+-]?\d+)?')
_BARE = re.compile(r'[A-Za-z0-9_-]+')
_SIMPLE = {'"': '"', '\\': '\\', 'b': '\b', 't': '\t', 'n': '\n', 'f': '\f', 'r': '\r'}


class _Reader:
    def __init__(self, text):
        self.text, self.index = text, 0

    def blanks(self):
        while self.index < len(self.text) and self.text[self.index] in ' \t':
            self.index += 1

    def expect(self, character):
        self.blanks()
        if self.text[self.index:self.index+1] != character:
            raise ValueError('expected ' + character)
        self.index += 1

    def string(self):
        self.expect('"')
        out = []
        while True:
            character = self.text[self.index]
            self.index += 1
            if character == '"':
                return ''.join(out)
            if ord(character) < 0x20 or ord(character) == 0x7f:
                raise ValueError('unescaped control character')
            if character != '\\':
                out.append(character)
                continue
            escape = self.text[self.index]
            self.index += 1
            if escape in _SIMPLE:
                out.append(_SIMPLE[escape])
            elif escape in 'uU':
                width = 4 if escape == 'u' else 8
                digits = self.text[self.index:self.index+width]
                if len(digits) != width or not re.fullmatch('[0-9A-Fa-f]+', digits):
                    raise ValueError('bad unicode escape')
                code = int(digits, 16)
                if 0xd800 <= code <= 0xdfff or code > 0x10ffff:
                    raise ValueError('not a scalar value')
                out.append(chr(code))
                self.index += width
            else:
                raise ValueError('unknown escape')

    def key(self):
        self.blanks()
        if self.text[self.index] == '"':
            return self.string()
        match = _BARE.match(self.text, self.index)
        if not match:
            raise ValueError('bad key')
        self.index = match.end()
        return match.group()

    def value(self):
        self.blanks()
        character = self.text[self.index]
        if character == '"':
            return self.string()
        if character == '{':
            return self.table()
        if character == '[':
            return self.array()
        for word, result in (('true', True), ('false', False)):
            if self.text.startswith(word, self.index):
                self.index += len(word)
                return result
        match = _NUMBER.match(self.text, self.index)
        if not match:
            raise ValueError('bad value')
        self.index = match.end()
        return float(match.group()) if match.group(1) or match.group(2) else int(match.group())

    def table(self):
        self.expect('{')
        result = {}
        self.blanks()
        if self.text[self.index] == '}':
            self.index += 1
            return result
        while True:
            name = self.key()
            if name in result:
                raise ValueError('duplicate key')
            self.expect('=')
            result[name] = self.value()
            self.blanks()
            character = self.text[self.index]
            self.index += 1
            if character == '}':
                return result
            if character != ',':
                raise ValueError('expected , or }')

    def array(self):
        self.expect('[')
        result = []
        self.blanks()
        if self.text[self.index] == ']':
            self.index += 1
            return result
        while True:
            result.append(self.value())
            self.blanks()
            character = self.text[self.index]
            self.index += 1
            if character == ']':
                return result
            if character != ',':
                raise ValueError('expected , or ]')


def parse_value(text):
    reader = _Reader(text)
    value = reader.value()
    reader.blanks()
    if reader.index != len(text):
        raise ValueError('trailing text')
    return value


def parse_override(argument):
    """`key.path=<value>` as given to `-c`: returns (key path, value)."""
    key, _, value = argument.partition('=')
    return key, parse_value(value)
