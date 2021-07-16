package bbk


 type Option struct {
	 ListenAddr 	string      `json:"listenAddr"`
	 ListenPort    int         `json:"listenPort"`
	 Password     string      `json:"password"`
	 Method       string      `json:"method"`
	 logLevel       string      `json:"logLevel"`
	 websocketUrl       string      `json:"websocketUrl"`
	 websocketPath       string      `json:"websocketPath"`
	 fillByte       int      `json:"fillByte"`
	 ping       bool      `json:"ping"`
 }
 