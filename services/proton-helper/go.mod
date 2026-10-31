module cloud-mail/proton-helper

go 1.26.0

require (
	github.com/ProtonMail/go-crypto v1.5.2
	github.com/emersion/go-message v0.18.2
	github.com/emersion/hydroxide v0.0.0
)

require (
	github.com/cloudflare/circl v1.6.5 // indirect
	github.com/emersion/go-bcrypt v0.0.0-20170822072041-6e724a1baa63 // indirect
	golang.org/x/crypto v0.58.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
)

replace github.com/emersion/hydroxide => ./third_party/hydroxide
