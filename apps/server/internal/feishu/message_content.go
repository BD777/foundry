package feishu

import (
	"encoding/json"
	"regexp"
	"strings"
)

// A received message's content is JSON whose shape its message_type names
// (Feishu IM "receive message content"): text and post carry text, and a
// post may embed images (img) and videos (media); image, file, audio and
// media messages carry one file the bot downloads (Client.MessageResource).
// Every other type is named in the text, never passed on as its JSON.

// messageResource is a file a message carries: Feishu's key for it, the
// resource type its download takes ("image" or "file"), the name the
// message gives it, and what the prompt calls it.
type messageResource struct {
	key          string
	resourceType string
	name         string
	label        string
}

// incomingMessage is a message as a session reads it: its text, each file
// marked where it was sent ("[image]"), and the files to bring along.
type incomingMessage struct {
	text      string
	resources []messageResource
}

func parseMessage(messageType, content string) incomingMessage {
	switch messageType {
	case "text":
		var body struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal([]byte(content), &body)
		return incomingMessage{text: strings.TrimSpace(mentionKeys.ReplaceAllString(body.Text, ""))}
	case "post":
		return parsePost(content)
	case "image", "file", "audio", "media":
		var body struct {
			ImageKey string `json:"image_key"`
			FileKey  string `json:"file_key"`
			FileName string `json:"file_name"`
		}
		_ = json.Unmarshal([]byte(content), &body)
		resource := fileResource(messageType, body.FileKey, body.FileName)
		if messageType == "image" {
			resource = imageResource(body.ImageKey)
		}
		if resource.key == "" {
			return incomingMessage{text: "[" + resource.label + "]"}
		}
		return incomingMessage{text: resource.marker(), resources: []messageResource{resource}}
	case "":
		return incomingMessage{text: "[message]"}
	default:
		return incomingMessage{text: "[" + messageType + "]"}
	}
}

var mentionKeys = regexp.MustCompile(`@_user_\d+|@_all`)

func imageResource(key string) messageResource {
	return messageResource{key: key, resourceType: "image", label: "image"}
}

// fileResource is a file, voice message or video; Feishu serves all three
// as resource type "file".
func fileResource(messageType, key, name string) messageResource {
	resource := messageResource{key: key, resourceType: "file", name: strings.TrimSpace(name), label: "file"}
	switch messageType {
	case "audio":
		resource.label = "audio"
	case "media":
		resource.label = "video"
	}
	return resource
}

// marker is how the text says the file was sent.
func (r messageResource) marker() string {
	if r.name != "" {
		return "[" + r.label + ": " + r.name + "]"
	}
	return "[" + r.label + "]"
}

// fileName is the name the file is stored under when neither the message
// nor the download names it.
func (r messageResource) fileName() string {
	switch {
	case r.name != "":
		return r.name
	case r.label == "audio":
		return "audio.opus"
	case r.label == "video":
		return "video.mp4"
	}
	return r.label
}

type postElement struct {
	Tag      string `json:"tag"`
	Text     string `json:"text"`
	ImageKey string `json:"image_key"`
	FileKey  string `json:"file_key"`
}

type postBody struct {
	Title   string          `json:"title"`
	Content [][]postElement `json:"content"`
}

// parsePost reads a post as received ({"title","content"}) or as sent in
// one locale ({"zh_cn":{"title","content"}}).
func parsePost(content string) incomingMessage {
	var post postBody
	if err := json.Unmarshal([]byte(content), &post); err == nil && (post.Title != "" || len(post.Content) > 0) {
		return postMessage(post)
	}
	var localized map[string]postBody
	if err := json.Unmarshal([]byte(content), &localized); err == nil {
		for _, post := range localized {
			if message := postMessage(post); message.text != "" {
				return message
			}
		}
	}
	return incomingMessage{}
}

func postMessage(post postBody) incomingMessage {
	var message incomingMessage
	var lines []string
	if title := strings.TrimSpace(post.Title); title != "" {
		lines = append(lines, title)
	}
	for _, paragraph := range post.Content {
		var line strings.Builder
		for _, element := range paragraph {
			switch element.Tag {
			case "text", "a", "code_block", "md":
				line.WriteString(element.Text)
			case "img", "media":
				resource := imageResource(element.ImageKey)
				if element.Tag == "media" {
					resource = fileResource("media", element.FileKey, "")
				}
				if resource.key != "" {
					message.resources = append(message.resources, resource)
				}
				line.WriteString(resource.marker())
			}
		}
		if trimmed := strings.TrimSpace(line.String()); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	message.text = strings.TrimSpace(strings.Join(lines, "\n"))
	return message
}

// cleanLeadingMentions drops the mentions a message opens with.
func cleanLeadingMentions(text string) string {
	text = strings.TrimSpace(text)
	for strings.HasPrefix(text, "@") {
		idx := strings.IndexAny(text, " \t\n\r")
		if idx == -1 {
			return ""
		}
		text = strings.TrimSpace(text[idx:])
	}
	return text
}
