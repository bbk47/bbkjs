package bbk

type Option struct {
	Mode          string `json:"mode"`
	ListenAddr    string `json:"listenAddr"`
	ListenPort    int    `json:"listenPort"`
	Password      string `json:"password"`
	Method        string `json:"method"`
	LogLevel      string `json:"logLevel"`
	WebsocketUrl  string `json:"websocketUrl"`
	WebsocketPath string `json:"websocketPath"`
	FillByte      int    `json:"fillByte"`
	Ping          bool   `json:"ping"`
}
