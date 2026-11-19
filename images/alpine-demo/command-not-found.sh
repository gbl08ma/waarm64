# /etc/profile.d/command-not-found.sh (waarm64's alpine-demo image: images/alpine-demo/command-not-found.sh): a
# command that isn't installed is looked up in Alpine's packages, `main` first and then `community` (enabled in
# /etc/apk/repositories the first time a command needs it: an index four times main's), and when a package provides
# it, that package is installed and the command run. BusyBox ash calls the hook with the command's name alone, so the
# line typed at the prompt is run again from the shell's history, when it is that command alone with its arguments
# (plain words); anywhere else (a line with more after the command, a script, a pipeline's subshell) the hook installs
# the package and says to run the command again.
# No pipelines in the hook: in BusyBox 1.37's ash, one run from the hook never ends (its last command waits on a pipe
# the shell keeps open), so the line is run again by a child shell (cd and variables there don't stay).

command_not_found_handle() {
	local name=$1 pkg community= self line= h
	case $name in
	'' | */* | -*)
		printf 'sh: %s: not found\n' "$name" >&2
		return 127
		;;
	esac
	printf '%s: not installed; looking for it in Alpine'"'"'s packages...\n' "$name" >&2
	pkg=$(apk search -q -x "cmd:$name")
	while read -r line; do
		case $line in '#http'*/community) community=${line#\#} ;; esac
	done </etc/apk/repositories
	if [ -z "$pkg" ] && [ -n "$community" ]; then
		pkg=$(apk search -q -x --repository "$community" "cmd:$name")
		if [ -n "$pkg" ]; then
			printf 'It is in the community repository: enabling it (%s).\n' "$community" >&2
			sed -i "s|^#$community\$|$community|" /etc/apk/repositories
		fi
	fi
	pkg=${pkg%%[[:space:]]*} # the first, if several provide it
	if [ -z "$pkg" ]; then
		printf 'sh: %s: not found (no package provides it)\n' "$name" >&2
		return 127
	fi
	printf 'Installing %s (apk add %s)\n' "$pkg" "$pkg" >&2
	apk add "$pkg" || return 127
	hash -r
	# The line typed, if this is the prompt's own shell (not a subshell: /proc/self, read by a builtin, is this
	# process) and the line starts with the command.
	read -r self h </proc/self/stat
	case $- in *i*) ;; *) self= ;; esac
	# The shell's own history (`history`: "%4d %s" a line, the line typed last), through a file: a builtin's output
	# taken by $(...) hangs here as a pipeline does.
	history >/tmp/.command-not-found.$$ 2>/dev/null
	while IFS= read -r h; do line=$h; done </tmp/.command-not-found.$$
	rm -f /tmp/.command-not-found.$$
	line=${line#"${line%%[![:space:]]*}"}
	line=${line#*[0-9] }
	line=${line#"${line%%[![:space:]]*}"}
	# Run again only when the line is the command alone, with its arguments: the prompt's shell goes on with the rest of
	# the line once the hook returns (`cmd; x`, `cmd && x`, `cmd >f; x`), so a child running the whole line would run
	# that rest twice. Anything past plain words (`;`, `&`, `|`, a redirection, `$`, a backquote, parentheses, a
	# newline: even quoted, where they'd be harmless) leaves it to the visitor.
	case ${line#"$name"} in
	*[\;\&\|\<\>\$\`\(\)]* | *'
'*) line= ;;
	esac
	if [ "$self" = "$$" ] && [ -n "$line" ] && [ "${line%%[[:space:]]*}" = "$name" ]; then
		/bin/sh -c "$line"
		return
	fi
	printf '%s is installed: run %s again.\n' "$pkg" "$name" >&2
	return 127
}
